//! Captures whatever is playing through the default output device (Teams,
//! Zoom, a browser tab, or anything else sharing that device) via WASAPI
//! endpoint loopback, so it can be mixed with the microphone on the frontend
//! (see `src/lib/audio/appAudio.ts`).
//!
//! Endpoint loopback rather than process-specific (`AUDIOCLIENT_ACTIVATION_
//! TYPE_PROCESS_LOOPBACK`) capture: the latter was tried first and confirmed
//! to drop audio during real Teams/Zoom calls despite `include_tree` covering
//! child processes. Capturing the whole default render device instead is the
//! standard, better-supported WASAPI loopback mode, at the cost of also
//! picking up whatever else is playing through the same device (notification
//! sounds, etc.) during the call -- accepted as the right tradeoff for a
//! meeting-transcription tool, where silently missing the other participant's
//! audio is the worse failure mode.
//!
//! WASAPI's own format auto-conversion
//! (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, exposed by the `wasapi` crate as
//! `autoconvert: true`) means this module never needs its own resampler --
//! requesting 16 kHz mono directly from the loopback `AudioClient` is
//! honored.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

/// Matches `wav::SAMPLE_RATE`: app audio is captured pre-resampled to exactly
/// what the rest of the pipeline (mic, WAV file, whisper) already expects, so
/// the frontend mixer only ever adds two same-rate mono streams together.
const CAPTURE_SAMPLE_RATE: usize = 16_000;

/// How often the capture loop flushes to the frontend, and the unit silence is
/// padded in when nothing is playing. Small enough to keep the live view
/// responsive, large enough that per-chunk IPC overhead stays negligible at
/// 16 kHz mono (32 KB/s of raw data).
const CHUNK_MS: u64 = 100;
const CHUNK_SAMPLES: usize = CAPTURE_SAMPLE_RATE * CHUNK_MS as usize / 1000;

/// How far behind wall clock the output is allowed to fall before the loop
/// gives up on backfilling silence and simply resynchronises.
///
/// The silence padding below exists for scheduling jitter, which is measured
/// in milliseconds. A gap orders of magnitude larger than that means this loop
/// did not run at all for a while -- overwhelmingly: the PC suspended, since
/// `Instant` keeps advancing across modern-standby (S0) sleep. Backfilling
/// such a gap would be both pointless and harmful: pointless because the
/// microphone did not capture that stretch either (the frontend is frozen too,
/// so no mic frames exist to mix it with) and `AudioMixer` discards anything
/// past 5 queued seconds anyway; harmful because it is emitted as one tight
/// burst of `CHUNK_MS` messages -- an hour of sleep is 36,000 IPC sends with
/// no pause between them, which is a CPU spike and an IPC flood at the exact
/// moment the machine is busiest coming back up.
///
/// Matched to `AudioMixer`'s own queue cap: beyond it, output would be dropped
/// by the consumer regardless of what is sent here.
const MAX_CATCHUP_SAMPLES: u64 = 5 * CAPTURE_SAMPLE_RATE as u64;

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

/// Starts capturing whatever plays through the default output device and
/// streams 16 kHz mono f32 PCM to `channel` as raw binary frames, `CHUNK_MS`
/// worth at a time.
///
/// Any capture already running is stopped first (mirrors `capture::start_capture`
/// discarding a previous open recording): only one capture makes sense at a time.
#[tauri::command]
pub async fn start_app_audio_capture(
    app: AppHandle,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    stop_running_capture(&app);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let app_for_thread = app.clone();
    let thread = std::thread::Builder::new()
        .name("app-audio-capture".to_string())
        .spawn(move || {
            if let Err(message) = capture_loop(&channel, &stop_for_thread) {
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
/// well with an async runtime's work-stealing). Reads endpoint-loopback audio
/// in whatever chunks WASAPI delivers, and re-buffers them into fixed
/// `CHUNK_SAMPLES`-sized frames on a wall-clock schedule, padding with silence
/// when nothing is playing -- so a full minute of silence still advances the
/// output by a full minute, keeping the stream's duration in lockstep with
/// the microphone's.
/// Public (rather than private to this module) so an `examples/` probe can
/// call it directly without a Tauri runtime.
pub fn capture_loop(channel: &Channel<InvokeResponseBody>, stop: &AtomicBool) -> Result<(), String> {
    initialize_mta().ok().map_err(|e| e.to_string())?;

    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, CAPTURE_SAMPLE_RATE, 1, None);
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("既定の再生デバイスを取得できませんでした: {e}"))?;
    // A Render-direction device's AudioClient initialized for Capture is
    // WASAPI's standard endpoint-loopback mode (AUDCLNT_STREAMFLAGS_LOOPBACK
    // is set internally based on this direction mismatch).
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("システム音声の取得を開始できませんでした: {e}"))?;
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
            // even when nothing is playing and no event fires.
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
        // Capped for the same reason the loop above is: stopping a capture that
        // sat through a suspend must not write out hours of silence.
        if elapsed_samples > sent_samples && elapsed_samples - sent_samples <= MAX_CATCHUP_SAMPLES {
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
/// where nothing was playing during that stretch.
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

        // Suspended (or otherwise stalled) for longer than any backfill could
        // usefully cover -- skip the gap instead of emitting it. See
        // MAX_CATCHUP_SAMPLES. `pending` goes with it: whatever WASAPI hands
        // back after a resume belongs to the far side of the gap, and mixing
        // pre-suspend audio into post-resume mic frames is exactly the
        // misalignment this whole wall-clock scheme exists to prevent.
        if elapsed_samples - *sent_samples > MAX_CATCHUP_SAMPLES {
            *sent_samples = elapsed_samples;
            pending.clear();
            continue;
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
