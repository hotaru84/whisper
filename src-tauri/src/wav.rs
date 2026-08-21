//! Minimal RIFF/WAVE I/O for 16 kHz mono audio.
//!
//! Deliberately dependency-free, and deliberately shared: the live capture
//! writer, the post-hoc transcription driver, and the accuracy harness
//! (`examples/cer.rs`) all go through here. If the harness parsed WAVs
//! differently from the app, a CER measured on a fixture would say nothing about
//! what users actually get.

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

pub const SAMPLE_RATE: u32 = 16_000;

/// Bytes before the sample data in the canonical 44-byte header we write.
const HEADER_LEN: u64 = 44;
/// Offset of the RIFF chunk size field.
const RIFF_SIZE_OFFSET: u64 = 4;
/// Offset of the data chunk size field.
const DATA_SIZE_OFFSET: u64 = 40;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Reads a WAV file as mono f32 samples in [-1, 1].
///
/// Accepts the canonical formats an audio editor exports (16-bit integer PCM and
/// 32-bit float, mono or multi-channel) but requires 16 kHz: resampling is the
/// capture pipeline's job, and silently accepting another rate would produce a
/// plausible-looking transcript of the wrong audio. Anything else fails with a
/// message showing the ffmpeg command to convert it.
pub fn read(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }

    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);

    let mut format: Option<(u16, u16, u32, u16)> = None; // (fmt, channels, rate, bits)
    let mut data: Option<(usize, usize)> = None; // (offset, len)

    // Walk the chunk list rather than assuming "fmt " and "data" sit at fixed
    // offsets -- editors happily insert LIST/fact chunks ahead of them.
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32_at(pos + 4) as usize;
        let body = pos + 8;
        // A data chunk whose declared size overruns the file is what a capture
        // interrupted by a crash looks like. Salvage the samples that made it to
        // disk rather than refusing the whole recording.
        let size = if body + size > bytes.len() {
            if id == b"data" {
                bytes.len() - body
            } else {
                break;
            }
        } else {
            size
        };
        match id {
            b"fmt " if size >= 16 => {
                format = Some((
                    u16_at(body),
                    u16_at(body + 2),
                    u32_at(body + 4),
                    u16_at(body + 14),
                ));
            }
            b"data" => data = Some((body, size)),
            _ => {}
        }
        // Chunks are word-aligned; odd sizes carry a pad byte.
        pos = body + size + (size & 1);
    }

    let (fmt, channels, rate, bits) =
        format.ok_or_else(|| format!("{}: no fmt chunk", path.display()))?;
    let (off, len) = data.ok_or_else(|| format!("{}: no data chunk", path.display()))?;

    if rate != SAMPLE_RATE {
        return Err(format!(
            "{}: sample rate is {rate} Hz, expected {SAMPLE_RATE}. Convert with:\n  \
             ffmpeg -i \"{}\" -ar 16000 -ac 1 -c:a pcm_s16le \"<out>.wav\"",
            path.display(),
            path.display()
        ));
    }
    if channels == 0 {
        return Err(format!("{}: zero channels", path.display()));
    }

    // 1 = integer PCM, 3 = IEEE float.
    let interleaved: Vec<f32> = match (fmt, bits) {
        (1, 16) => bytes[off..off + len]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
        (3, 32) => bytes[off..off + len]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        _ => {
            return Err(format!(
                "{}: unsupported format (fmt={fmt}, {bits}-bit). Convert with:\n  \
                 ffmpeg -i \"{}\" -ar 16000 -ac 1 -c:a pcm_s16le \"<out>.wav\"",
                path.display(),
                path.display()
            ))
        }
    };

    if channels == 1 {
        return Ok(interleaved);
    }
    // Downmix by averaging, matching what the capture worklet does live.
    let n = channels as usize;
    Ok(interleaved
        .chunks_exact(n)
        .map(|frame| frame.iter().sum::<f32>() / n as f32)
        .collect())
}

/// How many samples (~1 minute of 16kHz mono) go into one streamed chunk of
/// [`read_wav_pcm`]. Bounds any single IPC payload without adding meaningful
/// round-trip overhead over an hour-long recording (~60 chunks), and doubles
/// as the read size passed to [`read_range`] per iteration.
const STREAM_CHUNK_SAMPLES: usize = SAMPLE_RATE as usize * 60;

fn f32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

/// Reads up to `max_samples` samples starting at `from_sec`, straight off
/// disk, without materializing anything before `from_sec` or decoding the
/// whole file the way [`read`] does.
///
/// Unlike `read`, this assumes the canonical format [`Writer`] itself always
/// produces (PCM, mono, 16-bit, `SAMPLE_RATE`, 44-byte header) rather than
/// walking a general chunk list -- acceptable because its only caller,
/// [`read_wav_pcm`], only ever points it at this app's own recordings. Follows
/// [`duration_sec`]'s header-only-read-plus-on-disk-clamp pattern, extended to
/// also seek and decode the requested sample range.
///
/// `from_sec` at or past the end of the file returns an empty (not an error)
/// result. A file truncated mid-write (crash, power cut) is clamped to
/// whatever is actually on disk, same as `duration_sec`.
pub fn read_range(path: &Path, from_sec: f32, max_samples: usize) -> Result<Vec<f32>, String> {
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header).map_err(|e| format!("{}: {e}", path.display()))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[12..16] != b"fmt " {
        return Err(format!("{}: not a canonical RIFF/WAVE header", path.display()));
    }

    let u16_at = |o: usize| u16::from_le_bytes([header[o], header[o + 1]]) as u32;
    let u32_at = |o: usize| {
        u32::from_le_bytes([header[o], header[o + 1], header[o + 2], header[o + 3]])
    };

    let fmt = u16_at(20);
    let channels = u16_at(22);
    let rate = u32_at(24);
    let bits = u16_at(34);
    if fmt != 1 || channels != 1 || bits != 16 || rate != SAMPLE_RATE {
        return Err(format!(
            "{}: not the canonical PCM/mono/16-bit/{SAMPLE_RATE}Hz format this app writes",
            path.display()
        ));
    }

    let on_disk_bytes = file
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len()
        .saturating_sub(HEADER_LEN);
    let declared_bytes = u32_at(DATA_SIZE_OFFSET as usize) as u64;
    let total_samples = declared_bytes.min(on_disk_bytes) / 2;

    let from_sample = ((from_sec.max(0.0)) * SAMPLE_RATE as f32) as u64;
    if from_sample >= total_samples {
        return Ok(Vec::new());
    }
    let want = (max_samples as u64).min(total_samples - from_sample);

    file.seek(SeekFrom::Start(HEADER_LEN + from_sample * 2))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mut buf = vec![0u8; (want * 2) as usize];
    let mut got = 0usize;
    loop {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Ok(buf[..got - (got % 2)]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect())
}

/// Streams a WAV's samples to the frontend in bounded chunks, for the
/// post-hoc transcription driver (`transcribeWavPostHoc` on the frontend) to
/// feed through the same windowed decoding the live streaming pass uses.
///
/// Reads via [`read_range`] one chunk at a time rather than [`read`] plus a
/// slice, so a resumed job (`from_sec` well into a long recording) never
/// decodes -- or holds in memory -- audio before its resume point, and at
/// most one chunk's worth of decoded samples is ever resident at once.
///
/// `from_sec` skips already-analyzed audio server-side, so resuming a
/// previously-cancelled pass on a long recording does not re-cross the IPC
/// boundary with audio the caller already has. Follows the same
/// `Channel<InvokeResponseBody>` streaming pattern as
/// `appaudio::start_app_audio_capture`.
#[tauri::command]
pub async fn read_wav_pcm(
    app: AppHandle,
    path: String,
    job_id: String,
    from_sec: f32,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let cancel = crate::cancel::flag(&app, &job_id);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cursor_sec = from_sec.max(0.0);
        loop {
            crate::cancel::check(&cancel)?;
            let chunk = read_range(Path::new(&path), cursor_sec, STREAM_CHUNK_SAMPLES)?;
            if chunk.is_empty() {
                break;
            }
            channel
                .send(InvokeResponseBody::Raw(f32_to_le_bytes(&chunk)))
                .map_err(|e| e.to_string())?;
            cursor_sec += chunk.len() as f32 / SAMPLE_RATE as f32;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How long a WAV runs, read from its 44-byte header rather than its samples.
///
/// [`read`] would answer this too, but it pulls the whole file into memory --
/// unacceptable for the one caller here, which asks about every stray file in
/// the recordings directory at startup and would otherwise page in gigabytes to
/// produce a handful of floats.
///
/// Only the canonical header [`Writer`] itself writes is understood (fmt at
/// offset 12, data at 36); anything else is an error rather than a guess, since
/// the only files this is pointed at are ones this app wrote.
///
/// The declared data size is clamped to what is actually on disk. A recording
/// whose app was killed mid-write -- the case this exists for -- can have a
/// header describing samples that never reached the file, and reporting a
/// duration longer than the audio would desynchronise every timeline derived
/// from it.
pub fn duration_sec(path: &Path) -> Result<f32, String> {
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[12..16] != b"fmt " {
        return Err(format!("{}: not a canonical RIFF/WAVE header", path.display()));
    }

    let u16_at = |o: usize| u16::from_le_bytes([header[o], header[o + 1]]) as u64;
    let u32_at = |o: usize| {
        u32::from_le_bytes([header[o], header[o + 1], header[o + 2], header[o + 3]]) as u64
    };

    let channels = u16_at(22);
    let rate = u32_at(24);
    let bits = u16_at(34);
    let bytes_per_sec = rate * channels * (bits / 8);
    if bytes_per_sec == 0 {
        return Err(format!("{}: unusable format in the WAV header", path.display()));
    }

    let on_disk = file
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len()
        .saturating_sub(HEADER_LEN);
    let data_bytes = u32_at(DATA_SIZE_OFFSET as usize).min(on_disk);
    Ok(data_bytes as f32 / bytes_per_sec as f32)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Appends 16 kHz mono audio to a 16-bit PCM WAV file as it is captured.
///
/// 16-bit rather than the f32 the capture pipeline hands us: it halves the file
/// (115 MB/hour instead of 230), it is what every audio editor opens without
/// complaint -- which matters because these recordings double as CER fixtures --
/// and its ~96 dB noise floor is orders of magnitude below anything the mel
/// spectrogram responds to.
///
/// The two header size fields are rewritten after every append, so the file on
/// disk is a valid, playable WAV at all times rather than only after a clean
/// [`finish`](Self::finish). A recording interrupted by a crash or a power cut
/// stays openable.
pub struct Writer {
    file: BufWriter<File>,
    path: PathBuf,
    samples: u64,
}

impl Writer {
    /// Creates `path` (and its parent directory) and writes the WAV header.
    pub fn create(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let file = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut writer = Self {
            file: BufWriter::new(file),
            path: path.to_path_buf(),
            samples: 0,
        };
        writer.write_header()?;
        Ok(writer)
    }

    fn write_header(&mut self) -> Result<(), String> {
        let data_bytes = self.samples * 2;
        let byte_rate = SAMPLE_RATE * 2; // mono, 2 bytes per sample
        let mut header = Vec::with_capacity(HEADER_LEN as usize);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&1u16.to_le_bytes()); // mono
        header.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        header.extend_from_slice(&byte_rate.to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes()); // block align
        header.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        header.extend_from_slice(b"data");
        header.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        debug_assert_eq!(header.len() as u64, HEADER_LEN);
        self.write_all_at(0, &header)
    }

    /// Appends samples, clamping to [-1, 1] before quantising.
    ///
    /// Clamping rather than wrapping: a sample above 1.0 (which the browser's
    /// float pipeline can produce) would otherwise overflow the i16 cast into a
    /// large negative value, turning a loud moment into a burst of noise.
    pub fn append(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut buf = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            // Scale by 32767 rather than 32768 so +1.0 maps to i16::MAX instead of
            // wrapping, and round rather than letting `as i16` truncate: truncation
            // is a systematic pull toward zero, i.e. a quiet DC-biased distortion,
            // and it doubles the quantisation error for free.
            buf.extend_from_slice(&((clamped * 32767.0).round() as i16).to_le_bytes());
        }
        let offset = HEADER_LEN + self.samples * 2;
        self.write_all_at(offset, &buf)?;
        self.samples += samples.len() as u64;
        self.patch_sizes()
    }

    /// Rewrites just the two size fields, leaving the write cursor at the end.
    fn patch_sizes(&mut self) -> Result<(), String> {
        let data_bytes = self.samples * 2;
        self.write_all_at(RIFF_SIZE_OFFSET, &((36 + data_bytes) as u32).to_le_bytes())?;
        self.write_all_at(DATA_SIZE_OFFSET, &(data_bytes as u32).to_le_bytes())?;
        // Without this the size fields can sit in the BufWriter while the sample
        // data has already been flushed past them, which is exactly the state a
        // crash would leave behind.
        self.file
            .flush()
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }

    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(offset))
            .and_then(|_| self.file.write_all(bytes))
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }

    pub fn duration_sec(&self) -> f32 {
        self.samples as f32 / SAMPLE_RATE as f32
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Flushes and closes the file, returning its path.
    pub fn finish(mut self) -> Result<PathBuf, String> {
        self.patch_sizes()?;
        self.file
            .flush()
            .map_err(|e| format!("{}: {e}", self.path.display()))?;
        Ok(self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two 16-bit steps: enough slack for rounding and the 32767/32768 scale
    /// asymmetry, far too little to hide a real ordering or sign error.
    const QUANT_TOLERANCE: f32 = 2.0 / 32768.0;

    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("whisper-scribe-wav-test-{name}-{}.wav", std::process::id()));
        p
    }

    #[test]
    fn round_trips_samples_through_a_file() {
        let path = temp_path("roundtrip");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.0, 0.5, -0.5, 1.0, -1.0]).expect("append");
        w.finish().expect("finish");

        let back = read(&path).expect("read");
        assert_eq!(back.len(), 5);
        assert_eq!(back[0], 0.0);
        // 16-bit quantisation plus the 32767/32768 scale asymmetry, so allow a
        // couple of steps -- tight enough to catch ordering or sign mistakes.
        for (got, want) in back.iter().zip([0.0, 0.5, -0.5, 1.0, -1.0]) {
            assert!((got - want).abs() < QUANT_TOLERANCE, "{got} vs {want}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn appends_across_calls_in_order() {
        let path = temp_path("append");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.1, 0.2]).expect("append 1");
        w.append(&[0.3]).expect("append 2");
        w.append(&[]).expect("empty append");
        w.append(&[0.4, 0.5]).expect("append 3");
        assert_eq!(w.duration_sec(), 5.0 / SAMPLE_RATE as f32);
        w.finish().expect("finish");

        let back = read(&path).expect("read");
        assert_eq!(back.len(), 5);
        for (got, want) in back.iter().zip([0.1, 0.2, 0.3, 0.4, 0.5]) {
            assert!((got - want).abs() < QUANT_TOLERANCE, "{got} vs {want}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn file_is_readable_before_finish_is_called() {
        // The crash case: the header must already describe the samples on disk.
        let path = temp_path("unfinished");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.25, -0.25, 0.75]).expect("append");

        let back = read(&path).expect("read while still open");
        assert_eq!(back.len(), 3);
        assert!((back[2] - 0.75).abs() < QUANT_TOLERANCE);

        drop(w);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clamps_instead_of_wrapping_on_out_of_range_input() {
        let path = temp_path("clamp");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[2.5, -2.5]).expect("append");
        w.finish().expect("finish");

        let back = read(&path).expect("read");
        // Wrapping would flip these signs; clamping keeps them at the rails.
        assert!(back[0] > 0.99, "{}", back[0]);
        assert!(back[1] < -0.99, "{}", back[1]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_recording_produces_a_valid_zero_sample_file() {
        let path = temp_path("empty");
        let w = Writer::create(&path).expect("create");
        w.finish().expect("finish");
        assert_eq!(read(&path).expect("read"), Vec::<f32>::new());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_non_wav_input() {
        let path = temp_path("garbage");
        std::fs::write(&path, b"this is not a wav file at all").expect("write");
        assert!(read(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn salvages_a_data_chunk_that_overruns_the_file() {
        // A capture killed mid-append: the size field promises more than is there.
        let path = temp_path("truncated");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.1, 0.2, 0.3, 0.4]).expect("append");
        w.finish().expect("finish");

        let mut bytes = std::fs::read(&path).expect("read raw");
        bytes.truncate(bytes.len() - 4); // lose the last two samples
        std::fs::write(&path, &bytes).expect("rewrite");

        let back = read(&path).expect("read truncated");
        assert_eq!(back.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_the_duration_of_a_still_open_recording_from_the_header() {
        // The interrupted-take case `duration_sec` exists for: the writer is
        // still open (the app was reloaded out from under it), so `finish` was
        // never called, yet the file must already report its real length.
        let path = temp_path("duration-open");
        let mut w = Writer::create(&path).expect("create");
        w.append(&vec![0.1; SAMPLE_RATE as usize * 2]).expect("append");

        let secs = duration_sec(&path).expect("duration");
        assert!((secs - 2.0).abs() < 1e-4, "{secs}");
        assert!((secs - w.duration_sec()).abs() < 1e-4);

        drop(w);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn duration_ignores_samples_the_header_promises_but_the_file_lacks() {
        let path = temp_path("duration-truncated");
        let mut w = Writer::create(&path).expect("create");
        w.append(&vec![0.1; SAMPLE_RATE as usize]).expect("append");
        w.finish().expect("finish");

        let mut bytes = std::fs::read(&path).expect("read raw");
        bytes.truncate(HEADER_LEN as usize + SAMPLE_RATE as usize); // half the samples
        std::fs::write(&path, &bytes).expect("rewrite");

        let secs = duration_sec(&path).expect("duration");
        assert!((secs - 0.5).abs() < 1e-4, "{secs}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn duration_rejects_a_file_that_is_not_a_wav() {
        let path = temp_path("duration-garbage");
        std::fs::write(&path, b"not a wav file, but long enough to fill a header buffer!!")
            .expect("write");
        assert!(duration_sec(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_range_reads_the_requested_slice_from_the_middle_of_a_file() {
        let path = temp_path("range-middle");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]).expect("append");
        w.finish().expect("finish");

        let got = read_range(&path, 2.0 / SAMPLE_RATE as f32, 3).expect("read_range");
        assert_eq!(got.len(), 3);
        for (got, want) in got.iter().zip([0.3, 0.4, 0.5]) {
            assert!((got - want).abs() < QUANT_TOLERANCE, "{got} vs {want}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_range_from_sec_past_the_end_returns_empty() {
        let path = temp_path("range-past-end");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.1, 0.2]).expect("append");
        w.finish().expect("finish");

        let got = read_range(&path, 10.0, 100).expect("read_range");
        assert!(got.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_range_on_a_crash_truncated_file_returns_only_what_is_on_disk() {
        let path = temp_path("range-truncated");
        let mut w = Writer::create(&path).expect("create");
        w.append(&[0.1, 0.2, 0.3, 0.4]).expect("append");
        w.finish().expect("finish");

        let mut bytes = std::fs::read(&path).expect("read raw");
        bytes.truncate(bytes.len() - 4); // lose the last two samples, header still claims 4
        std::fs::write(&path, &bytes).expect("rewrite");

        let got = read_range(&path, 0.0, 100).expect("read_range");
        assert_eq!(got.len(), 2);
        let _ = std::fs::remove_file(&path);
    }
}
