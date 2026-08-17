# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WhisperScribe: a fully offline meeting-transcription desktop app for Windows. Tauri (Rust) + React/TypeScript frontend, with all transcription inference (`whisper-rs` / whisper.cpp, `large-v3-turbo` model, GPU-accelerated via Vulkan) running in the Rust backend. Optional Rust-side features: speaker diarization, VAD, and audio-event tagging (all via `sherpa-onnx`).

The README (`README.md`, in Japanese) is the primary design-decision log for this project — extremely detailed on *why* things are built the way they are (chunk-and-commit windowing, why VAD's measured effect is limited, why DTW timestamps matter for diarization, why the streaming/refine two-pass split exists, etc.). Read it before making changes to the audio/ASR pipeline; this file only summarizes the parts needed to navigate the code.

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
`npm run dev` (no Tauri, no Rust, works on any OS) serves the frontend at `http://localhost:1420` with every backend call faked — see `useMockBackend` in `src/lib/env.ts` for the full list of what is mocked and where. A `MOCK` badge in the titlebar marks the session. Good for UI/layout/state-machine work: recording, the live and refine passes, history browsing, playback (silent, but the timeline and seeking are real), diarization labels, audio events, and the 解析/解析中止 toggle all behave. Not usable for: real transcription, audible playback, app-audio (WASAPI) capture, transcript export, and the window controls — those need the Tauri runtime.

Mock behavior is gated on `import.meta.env.DEV` *and* on `isTauri()` being false, so `npm run tauri dev`/`tauri build` never take these paths. When adding a Tauri command, add its mock branch at the same time — an unmocked `invoke()` is a rejected promise that tends to get swallowed by a caller's `catch` and turn into a silently dead corner of the UI.

### Running a single frontend test
Vitest picks up `src/**/*.test.ts`. Use `npx vitest run path/to/file.test.ts` or `npx vitest run -t "test name"`.

### Model/resource files (not in git)
Required before first build: `src-tauri/resources/models/whisper-large-v3-turbo/model.gguf` (~574MB, see README for the download command). Optional model dirs: `diarization/`, `vad/`, `audio-tagging/` — each is a distinct opt-in feature; the app degrades gracefully (with a user-visible notice) if a given model is missing, except the base whisper model which is required. When adding a new model, add its directory explicitly to `bundle.resources` in `tauri.conf.json` — do not widen the glob, or unrelated local model files get bundled into the installer.

## Architecture

### Process split
- **Rust backend (`src-tauri/src/`)** owns: model loading, all whisper inference, diarization, audio-event detection, WAV file writing, and WASAPI process-loopback capture of other apps' audio (e.g. Teams/Zoom). Exposed to the frontend as Tauri commands, registered in `src-tauri/src/lib.rs`.
- **React frontend (`src/`)** owns: UI, microphone capture (`getUserMedia` + `AudioContext`/AudioWorklet), mixing mic + app audio, orchestrating when to call which Rust command, and all persisted UI/user settings (localStorage).

Rust modules (`src-tauri/src/`): `asr.rs` (model init + both transcription passes + decode settings shared with the CER harness), `capture.rs` (streaming WAV writer for the raw mic/mixed PCM sent from the frontend), `diarize.rs`, `events.rs` (audio tagging + non-speech chunk exclusion), `appaudio.rs` (WASAPI process-loopback), `wav.rs` (shared WAV reader/writer used by capture, the second pass, and the CER harness — keeps measured accuracy consistent with real behavior), `cer.rs` (character-error-rate metric, unit tested).

### Two-pass transcription (the core design)
1. **Streaming pass** (`src/lib/asr/streaming.ts` `StreamingTranscriber`): while recording, mic PCM is buffered into 15-second windows and each window is transcribed independently via the `transcribe_window` command as soon as it fills, so the user sees text appear quickly ("chunk-and-commit"). Windows are decoded independently, so text can be wrong/disjointed across window boundaries.
2. **Refine pass** (`asr::transcribe_recording`, driven from `src/store/recordingPipeline.ts`): once recording stops, the *entire* recording is re-transcribed in one `full()` call, letting whisper.cpp condition each internal 30s chunk on the previous chunk's tokens — context the streaming pass structurally can't have. This replaces the streaming segments once done; if it fails, the streaming result is kept (never lose what's already on screen).

Diarization and audio-event detection are separate post-stop passes over the whole recording (same rationale: the 15s streaming windows don't have enough context), invoked alongside the refine pass and merged onto the transcript by timestamp.

A "recording-only" mode skips loading the model and both streaming/refine entirely during recording (battery-saving); transcription is deferred until the user explicitly requests it later from history ("re-analyze", which just re-invokes the normal refine/diarize/audio-tag pipeline against the saved WAV).

### Frontend structure
- `src/store/appStore.ts` — the single Zustand store; central orchestration point tying together capture, streaming, refine, playback, and settings. It re-exports from `capabilities.ts`, `recordingPipeline.ts`, `timeline.ts`, and `playback.ts` rather than owning that logic directly — start there to see the seams.
- `src/store/capabilities.ts` — pure functions deriving UI-enabled/disabled state (`RecordingPhase`, `ProcessingPhase`, `ModelStatus` → `selectCapabilities`) with zero Tauri/audio dependencies, so they're cheaply unit-testable (`capabilities.test.ts`) — this is deliberate: state-machine bugs here are the kind that silently fall through `===` chains.
- `src/store/recordingPipeline.ts` — the stop-recording orchestration (refine, diarize, audio-tag, record-only finish).
- `src/store/timeline.ts` — cross-recording timeline bookkeeping (segment IDs and time offsets accumulate across start/stop cycles within one session).
- `src/lib/asr/` — `client.ts` (Tauri command wrappers + event listeners), `streaming.ts` (the windowing transcriber), `types.ts`.
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
- Silence must be filtered on the input side (RMS gate, `SILENCE_RMS` in `src/lib/asr/diagnostics.ts` for streaming; `asr::drop_silent_segments` for the refine pass), not by inspecting output text — whisper hallucinates stock phrases on silence, and filtering by text risks deleting legitimate short utterances.
- GPU (Vulkan) is enabled via the `vulkan` Cargo feature (on by default in `src-tauri/Cargo.toml`); no application code needs to branch on it. Build CPU-only with `--no-default-features` if needed.
