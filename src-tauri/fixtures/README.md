# Accuracy fixtures

Pairs of `<name>.wav` and `<name>.txt` consumed by the CER harness:

```
scripts\win-build-env.bat cargo run --release --example cer
```

- `<name>.wav` — 16 kHz mono. 16-bit PCM or 32-bit float. Convert anything else:
  `ffmpeg -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le name.wav`
- `<name>.txt` — the reference transcript, UTF-8, transcribed by hand.

The audio and references are gitignored (this README is not) so recordings never
land in the repo.

## What makes a useful set

The stated use case is meetings and longer recordings, so aim for 3-5 minutes per
fixture and cover the conditions that actually differ:

- one clean recording, single speaker, quiet room — the baseline
- one with background noise, or several speakers and some overlap
- one dense with proper nouns, product names and jargon — where a general model
  is weakest and where a glossary prompt would later show its worth

Reference transcripts should record what was *said*, including fillers, without
tidying grammar. The harness strips punctuation before comparing by default, so
don't agonise over 、。 placement.
