//! Captures audio rendered by a specific application (Teams, Zoom, a browser
//! tab, ...) via WASAPI process-loopback, so it can be mixed with the
//! microphone on the frontend (see `src/lib/audio/appAudio.ts`).
//!
//! Two things make this simpler than it might look:
//!
//! - WASAPI's own format auto-conversion (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`,
//!   exposed by the `wasapi` crate as `autoconvert: true`) works even in
//!   process-loopback mode -- verified by spike: requesting 16 kHz mono
//!   directly from a loopback `AudioClient` is honored, so this module never
//!   needs its own resampler. Confirmed with a self-capture test (this
//!   process playing a tone while capturing its own loopback) before writing
//!   any of this.
//! - `chrono`-less, `sysinfo`-less process name resolution: `wasapi`'s
//!   session enumeration already hands back a PID, and `windows`'
//!   `QueryFullProcessImageNameW` (a dependency `wasapi` already pulls in)
//!   turns that into a friendly name without adding a new crate.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, SessionState,
    StreamMode, WaveFormat,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Matches `wav::SAMPLE_RATE`: app audio is captured pre-resampled to exactly
/// what the rest of the pipeline (mic, WAV file, whisper) already expects, so
/// the frontend mixer only ever adds two same-rate mono streams together.
const CAPTURE_SAMPLE_RATE: usize = 16_000;

/// How often the capture loop flushes to the frontend, and the unit silence is
/// padded in when the target app renders nothing. Small enough to keep the
/// live view responsive, large enough that per-chunk IPC overhead stays
/// negligible at 16 kHz mono (32 KB/s of raw data).
const CHUNK_MS: u64 = 100;
const CHUNK_SAMPLES: usize = CAPTURE_SAMPLE_RATE * CHUNK_MS as usize / 1000;

/// One application currently capable of being targeted: it has an active
/// WASAPI audio session, so `new_application_loopback_client` can capture it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioAppInfo {
    pub process_id: u32,
    pub name: String,
}

/// Lists apps with an active audio session, across every render device.
///
/// Only apps that already have an open audio stream show up here -- this is a
/// WASAPI limitation, not a choice this app makes: Windows exposes "which
/// processes currently have an audio session", not "which processes could
/// make sound". In practice this means the target (Teams, Zoom, ...) has to
/// already be playing something -- e.g. the user has joined the call -- before
/// it appears, and the frontend needs a refresh button rather than expecting a
/// one-shot list to stay accurate.
#[tauri::command]
pub async fn list_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_audio_apps_sync)
        .await
        .map_err(|e| e.to_string())?
}

/// The blocking WASAPI work behind [`list_audio_apps`], pulled out so it can
/// be exercised directly -- from a unit test or a throwaway `examples/`
/// probe -- without a Tauri runtime to host the async command.
pub fn list_audio_apps_sync() -> Result<Vec<AudioAppInfo>, String> {
    // Ignored: benign "already initialized" on a thread pool worker reused
    // across calls is expected, and any real failure surfaces from the
    // enumerator call right after.
    let _ = initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let devices = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|e| e.to_string())?;

    let mut seen_pids = HashSet::new();
    let mut apps = Vec::new();
    for device in devices.into_iter().flatten() {
        let Ok(manager) = device.get_iaudiosessionmanager() else {
            continue;
        };
        let Ok(sessions) = manager.get_audiosessionenumerator() else {
            continue;
        };
        let Ok(count) = sessions.get_count() else {
            continue;
        };
        for i in 0..count {
            let Ok(control) = sessions.get_session(i) else {
                continue;
            };
            if control.get_state().ok() != Some(SessionState::Active) {
                continue;
            }
            let Ok(pid) = control.get_process_id() else {
                continue;
            };
            // pid 0 is the system "sounds" session (not a real app); a
            // process can also hold sessions on more than one device.
            if pid == 0 || !seen_pids.insert(pid) {
                continue;
            }
            let name = process_name(pid).unwrap_or_else(|| format!("PID {pid}"));
            apps.push(AudioAppInfo { process_id: pid, name });
        }
    }
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(apps)
}

/// Resolves a process's executable file name (no directory, no extension
/// stripped) via `QueryFullProcessImageNameW`. Returns `None` for a process
/// this one cannot query (protected system process, or it has already
/// exited) -- the caller falls back to showing the bare PID rather than
/// failing the whole listing over one uninspectable process.
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260]; // MAX_PATH
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
    }
}

#[derive(Clone, Serialize)]
struct AppAudioErrorPayload {
    message: String,
}

/// Handle to a running capture, so `stop_app_audio_capture` can ask the
/// capture thread to wind down and wait for it.
struct CaptureHandle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct AppAudioState(Mutex<Option<CaptureHandle>>);

/// Starts capturing `process_id`'s rendered audio (and its child processes',
/// per `include_tree`) and streams 16 kHz mono f32 PCM to `channel` as raw
/// binary frames, `CHUNK_MS` worth at a time.
///
/// Any capture already running is stopped first (mirrors `capture::start_capture`
/// discarding a previous open recording): only one target makes sense at a time.
#[tauri::command]
pub async fn start_app_audio_capture(
    app: AppHandle,
    process_id: u32,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    stop_running_capture(&app);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let app_for_thread = app.clone();
    let thread = std::thread::Builder::new()
        .name("app-audio-capture".to_string())
        .spawn(move || {
            if let Err(message) = capture_loop(process_id, &channel, &stop_for_thread) {
                let _ = app_for_thread.emit("asr:app-audio-error", AppAudioErrorPayload { message });
            }
        })
        .map_err(|e| e.to_string())?;

    *app.state::<AppAudioState>().0.lock().unwrap() = Some(CaptureHandle { stop, thread });
    Ok(())
}

#[tauri::command]
pub async fn stop_app_audio_capture(app: AppHandle) -> Result<(), String> {
    stop_running_capture(&app);
    Ok(())
}

fn stop_running_capture(app: &AppHandle) {
    let handle = app.state::<AppAudioState>().0.lock().unwrap().take();
    if let Some(handle) = handle {
        handle.stop.store(true, Ordering::Relaxed);
        // The capture loop polls `stop` at least once per CHUNK_MS, so this
        // join is bounded and short -- safe to do on the async command's
        // blocking-adjacent call path.
        let _ = handle.thread.join();
    }
}

/// Runs on its own OS thread (WASAPI's MTA + event-driven capture do not mix
/// well with an async runtime's work-stealing). Reads process-loopback audio
/// in whatever chunks WASAPI delivers, and re-buffers them into fixed
/// `CHUNK_SAMPLES`-sized frames on a wall-clock schedule, padding with silence
/// when the target renders nothing -- so a full minute of silence from a
/// muted participant still advances the output by a full minute, keeping the
/// stream's duration in lockstep with the microphone's.
/// Public (rather than private to this module) so an `examples/` probe can
/// call it directly against a real target without a Tauri runtime -- the same
/// reasoning as `list_audio_apps_sync`.
pub fn capture_loop(
    process_id: u32,
    channel: &Channel<InvokeResponseBody>,
    stop: &AtomicBool,
) -> Result<(), String> {
    initialize_mta().ok().map_err(|e| e.to_string())?;

    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, CAPTURE_SAMPLE_RATE, 1, None);
    let include_tree = true; // Teams/Zoom render audio from child processes.
    let mut audio_client = AudioClient::new_application_loopback_client(process_id, include_tree)
        .map_err(|e| format!("対象アプリの音声取得を開始できませんでした（既に終了した可能性があります）: {e}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;
    let h_event = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture_client = audio_client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    let started = Instant::now();
    // Samples already sent, in terms of wall-clock time -- the basis for
    // deciding how much silence to backfill on the next flush.
    let mut sent_samples: u64 = 0;
    let mut pending: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES * 2);

    let result = (|| -> Result<(), String> {
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            // Short timeout, not the packet-arrival wait itself: this is what
            // lets the loop notice `stop` and the silence deadline promptly
            // even when the target app renders nothing and no event fires.
            let _ = h_event.wait_for_event(CHUNK_MS as u32);

            if let Some(new_frames) = capture_client.get_next_packet_size().map_err(|e| e.to_string())? {
                if new_frames > 0 {
                    let mut buf = vec![0u8; new_frames as usize * 4]; // mono f32
                    let (frames_written, _flags) =
                        capture_client.read_from_device(&mut buf).map_err(|e| e.to_string())?;
                    let n = frames_written as usize;
                    pending.extend(
                        buf[..n * 4]
                            .chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])),
                    );
                }
            }

            flush_due_chunks(&mut pending, &mut sent_samples, started, channel)?;
        }
        // Final flush: whatever is left, plus silence up to "now", so the
        // stream's total duration matches how long capture actually ran.
        flush_due_chunks(&mut pending, &mut sent_samples, started, channel)?;
        let elapsed_samples = (started.elapsed().as_secs_f64() * CAPTURE_SAMPLE_RATE as f64) as u64;
        if elapsed_samples > sent_samples {
            let silence = vec![0.0f32; (elapsed_samples - sent_samples) as usize];
            channel.send(InvokeResponseBody::Raw(f32_to_le_bytes(&silence))).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let _ = audio_client.stop_stream();
    result
}

/// Sends complete `CHUNK_SAMPLES` frames as they become due (per wall-clock
/// elapsed time since `started`), backfilling with silence if `pending` has
/// not accumulated enough real samples to cover the elapsed time -- the case
/// where the target app rendered nothing during that stretch.
fn flush_due_chunks(
    pending: &mut Vec<f32>,
    sent_samples: &mut u64,
    started: Instant,
    channel: &Channel<InvokeResponseBody>,
) -> Result<(), String> {
    loop {
        let elapsed_samples = (started.elapsed().as_secs_f64() * CAPTURE_SAMPLE_RATE as f64) as u64;
        if elapsed_samples < *sent_samples + CHUNK_SAMPLES as u64 {
            break;
        }

        let chunk: Vec<f32> = if pending.len() >= CHUNK_SAMPLES {
            pending.drain(..CHUNK_SAMPLES).collect()
        } else {
            // Not enough real audio arrived for this window: take what there
            // is and pad the rest with silence, rather than stalling output
            // (and thus the mic/app-audio alignment) until real audio shows up.
            let mut chunk = std::mem::take(pending);
            chunk.resize(CHUNK_SAMPLES, 0.0);
            chunk
        };

        channel.send(InvokeResponseBody::Raw(f32_to_le_bytes(&chunk))).map_err(|e| e.to_string())?;
        *sent_samples += CHUNK_SAMPLES as u64;
    }
    Ok(())
}

fn f32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}
