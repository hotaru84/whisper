# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WhisperScribe: a fully offline meeting-transcription desktop app for Windows. Tauri (Rust) + React/TypeScript frontend, with all transcription inference (`whisper-rs` / whisper.cpp, `large-v3-turbo` model, GPU-accelerated via Vulkan) running in the Rust backend. Optional Rust-side features: speaker diarization and audio-event tagging (both via `sherpa-onnx`).

The README (`README.md`, in Japanese) is the primary design-decision log for this project — extremely detailed on *why* things are built the way they are (chunk-and-commit windowing, why DTW timestamps matter for diarization, etc.). Read it before making changes to the audio/ASR pipeline; this file only summarizes the parts needed to navigate the code.

**There is only one transcription pass, everywhere.** A separate whole-file "accuracy pass" (`asr::transcribe_recording`) used to re-transcribe every recording from scratch after it stopped; it was removed because its benefit over the windowed streaming pass was never actually measured (the CER harness only ever exercised the whole-file decode path) and it carried its own structural failure modes. All transcription — live, record-only's deferred analysis, and history re-analysis — now goes through the same windowed, chunk-and-commit `StreamingTranscriber`/`transcribe_window` path. VAD was removed alongside it: it only ever worked inside that whole-file `full()` call and structurally can't apply to independent windows.

## Commands

All commands are run from the repo root.

```powershell
npm install                    # setup
npm run tauri dev              # dev: Vite dev server (localhost:1420) + native Tauri window
npm run dev                    # frontend only, in a plain browser (localhost:1420) — see "Browser-only dev mode"
npm run tauri build -- --no-bundle   # portable exe only, fastest way to sanity-check a build
npm run tauri build            # full NSIS installer build (~600-650MB, bundles the model)
npm run build                  # tsc typecheck + vite build (frontend only, no Tauri)
npm run lint                   # oxlint .
npm test                       # vitest run (frontend unit tests)
npm run icons                  # regenerate app icons from scripts/generate-icons.mjs
```

Rust-side (from `src-tauri/`, or via the wrapper — see below):
```powershell
cargo test --lib                                    # Rust unit tests (e.g. cer.rs)
scripts\win-build-env.bat cargo run --release --example cer     # accuracy (CER) harness
scripts\win-build-env.bat cargo run --release --example tokens -- "<text>"  # count tokens for a glossary/prompt string
```

**Never invoke `cargo build`/`cargo tauri` directly — always go through `npm run tauri ...`.** The `tauri` npm script is a wrapper (`scripts/win-build-env.bat`) that sets up `cl.exe`, Ninja, `LIBCLANG_PATH`, and checks `VULKAN_SDK` before calling the Tauri CLI. Without it, the nested CMake `ExternalProject` that builds Vulkan shaders fails to find a compiler. Build settings that must stay declarative (Ninja generator, short target dir `C:/wsbuild` to dodge `MAX_PATH`) live in `.cargo/config.toml` at the repo root — it must stay there, not under `src-tauri/`, because Cargo searches upward from the current directory rather than from the manifest.

### Browser-only dev mode
`npm run dev` (no Tauri, no Rust, works on any OS) serves the frontend at `http://localhost:1420` with every backend call faked — see `useMockBackend` in `src/lib/env.ts` for the full list of what is mocked and where. A `MOCK` badge in the titlebar marks the session. Good for UI/layout/state-machine work: recording, live and post-hoc transcription, history browsing, playback (silent, but the timeline and seeking are real), diarization labels, audio events, and the 解析/解析中止 toggle all behave. Not usable for: real transcription, audible playback, app-audio (WASAPI) capture, transcript export, and the window controls — those need the Tauri runtime.

Mock behavior is gated on `import.meta.env.DEV` *and* on `isTauri()` being false, so `npm run tauri dev`/`tauri build` never take these paths. When adding a Tauri command, add its mock branch at the same time — an unmocked `invoke()` is a rejected promise that tends to get swallowed by a caller's `catch` and turn into a silently dead corner of the UI.

### Running a single frontend test
Vitest picks up `src/**/*.test.ts`. Use `npx vitest run path/to/file.test.ts` or `npx vitest run -t "test name"`.

### Model/resource files (not in git)
Required before first build: `src-tauri/resources/models/whisper-large-v3-turbo/model.gguf` (~574MB, see README for the download command). Optional model dirs: `diarization/`, `audio-tagging/` — each is a distinct opt-in feature; the app degrades gracefully (with a user-visible notice) if a given model is missing, except the base whisper model which is required. When adding a new model, add its directory explicitly to `bundle.resources` in `tauri.conf.json` — do not widen the glob, or unrelated local model files get bundled into the installer.

## Architecture

### Process split
- **Rust backend (`src-tauri/src/`)** owns: model loading, all whisper inference, diarization, audio-event detection, WAV file writing, and WASAPI process-loopback capture of other apps' audio (e.g. Teams/Zoom). Exposed to the frontend as Tauri commands, registered in `src-tauri/src/lib.rs`.
- **React frontend (`src/`)** owns: UI, microphone capture (`getUserMedia` + `AudioContext`/AudioWorklet), mixing mic + app audio, orchestrating when to call which Rust command, and all persisted UI/user settings (localStorage).

Rust modules (`src-tauri/src/`): `asr.rs` (model init + the one transcription decode path + decode settings shared with the CER harness), `capture.rs` (streaming WAV writer for the raw mic/mixed PCM sent from the frontend), `diarize.rs`, `events.rs` (audio tagging + non-speech chunk exclusion), `appaudio.rs` (WASAPI process-loopback), `wav.rs` (shared WAV reader/writer used by capture, the post-hoc transcription driver, and the CER harness — keeps measured accuracy consistent with real behavior), `cer.rs` (character-error-rate metric, unit tested).

### Windowed transcription, everywhere (the core design)
Every transcription — live or post-hoc — goes through the same `StreamingTranscriber` (`src/lib/asr/streaming.ts`): PCM is buffered into 30-second windows and each window is transcribed independently via the `transcribe_window` command as soon as it fills, chunk-and-commit style (commit all-but-the-last whisper chunk per window, carry the tail into the next window so a sentence isn't cut mid-word at a boundary). Windows are decoded independently — a fresh `whisper_state` per call — so text can be wrong/disjointed exactly at window boundaries; there is no whole-file pass that carries context across them.

- **Live "record and analyze" mode**: `StreamingTranscriber` is fed mic frames in real time during recording, so the transcript is already complete by the time recording stops. The only post-stop transcription-adjacent work is `asr::finalize_transcript` — a repair/analysis tail (`redecode_degenerate_loops`, `redecode_voiced_gaps`, `mark_silent_segments`/`cues::analyze`) run once over the already-produced chunks plus the finished WAV — followed by diarization and audio-tagging.
- **Record-only mode / history "再解析"**: no live transcription happened, so a post-hoc driver (`src/lib/asr/postHocTranscriber.ts`'s `transcribeWavPostHoc`) reads the WAV's PCM via the `read_wav_pcm` command and feeds it through a fresh `StreamingTranscriber` at background queue priority, exactly mirroring the live path. This is **resumable**: each committed window is persisted to the history sidecar immediately (`analyzedThroughSec` tracks progress), so cancelling partway keeps everything already transcribed, and a later "解析"/"続きを解析" click picks up from the cursor instead of re-decoding from the start. `asr::finalize_transcript` then runs once over the full assembled chunk list once decoding reaches the end.

Diarization and audio-event detection are separate post-stop passes over the whole recording (same rationale: a single streaming window doesn't have enough context), invoked after the transcript is finalized and merged onto it by timestamp.

A "recording-only" mode skips loading the model and the streaming transcriber entirely during recording (battery-saving); transcription is deferred until the user explicitly requests it later from history ("解析"), which runs the same resumable post-hoc driver described above.

### Frontend structure
- `src/store/appStore.ts` — the single Zustand store; central orchestration point tying together capture, streaming, refine, playback, and settings. It re-exports from `capabilities.ts`, `recordingPipeline.ts`, `timeline.ts`, and `playback.ts` rather than owning that logic directly — start there to see the seams.
- `src/store/capabilities.ts` — pure functions deriving UI-enabled/disabled state (`RecordingPhase`, `ProcessingPhase`, `ModelStatus` → `selectCapabilities`) with zero Tauri/audio dependencies, so they're cheaply unit-testable (`capabilities.test.ts`) — this is deliberate: state-machine bugs here are the kind that silently fall through `===` chains.
- `src/store/recordingPipeline.ts` — the stop-recording and post-hoc-analysis orchestration (`finalizeAndEnrich`'s shared repair/diarize/audio-tag tail, `refineRecording` for live mode, `runPostHocAnalysis` for record-only/re-analyze, record-only finish).
- `src/store/timeline.ts` — cross-recording timeline bookkeeping (segment IDs and time offsets accumulate across start/stop cycles within one session).
- `src/lib/asr/` — `client.ts` (Tauri command wrappers + event listeners), `streaming.ts` (the windowing transcriber), `postHocTranscriber.ts` (drives `streaming.ts` from a WAV file instead of live mic frames, resumably), `types.ts`.
- `src/lib/audio/` — `pcmRecorder.ts` (mic capture via AudioWorklet, `public/pcm-capture-worklet.js`), `mixer.ts` (`AudioMixer`, mic-paced merge of mic + app audio), `devices.ts`, `capture.ts` (buffers PCM and forwards to the Rust WAV writer via binary IPC).
- `src/lib/transcript.ts` — `TranscriptSegment[]` model; `segmentsFromResult` turns raw ASR/diarize/event output into displayed segments (and is where excluded audio-event chunks disappear from the transcript).
- `src/lib/history.ts` — recording history persistence (WAV + sidecar JSON in the app cache dir).
- `src/components/` — UI components; `src/components/ui/` is shadcn/radix-ui primitives (see `components.json` for the shadcn config — style `radix-nova`, aliases under `@/`).

### Path aliases
`@/*` → `src/*` (defined in both `tsconfig.json` and `vite.config.ts`).

### Testing conventions
Frontend: Vitest, colocated `*.test.ts` next to the module under test, `environment: "node"` (no DOM). Rust: `cargo test --lib` covers `cer.rs`; accuracy itself is measured via the CER example harness against fixtures in `src-tauri/fixtures/` (gitignored `.wav`/`.txt` pairs, see `src-tauri/fixtures/README.md`), not via unit tests — decode settings are centralized in `asr::DecodeSettings`/`asr::build_full_params` so the app and the harness can never silently diverge.

### Key constraints worth knowing before touching the ASR pipeline
- Do not feed prior transcribed output back into the model as `initial_prompt` for the next window — this was tried and reverted because it self-amplifies repetition loops. A user-authored static glossary string in `initial_prompt` is fine (doesn't self-amplify); it's capped at ~224 tokens and silently truncated from the front, so put important terms last.
- Silence must be judged on the input side (RMS gate, `SILENCE_RMS` in `src/lib/asr/diagnostics.ts` for streaming; `asr::mark_silent_segments` inside `finalize_transcript`), not by inspecting output text — whisper hallucinates stock phrases on silence, and filtering by text risks deleting legitimate short utterances. `mark_silent_segments` flags rather than removes (the frontend renders a placeholder via `TranscriptSegment.excludedReason`), so a wrong RMS call is recoverable in the UI rather than a silently vanished sentence.
- GPU (Vulkan) is enabled via the `vulkan` Cargo feature (on by default in `src-tauri/Cargo.toml`); no application code needs to branch on it. Build CPU-only with `--no-default-features` if needed.
