export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/**
 * Turns the browser's raw device list into audio input options, with a
 * synthesized label when the real one isn't available yet.
 *
 * `MediaDeviceInfo.label` is the empty string until the page has been granted
 * microphone access at least once in this session -- a privacy measure so a
 * page can't fingerprint hardware before the user has opted in. Falling back
 * to "マイク N" (1-indexed) rather than leaving it blank keeps the settings
 * dropdown usable on a first visit, before any recording has started.
 *
 * Exported separately from `listAudioInputDevices` so this mapping is
 * unit-testable without mocking `navigator.mediaDevices`.
 */
export function toAudioInputDevices(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  let unlabeledCount = 0;
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `マイク ${++unlabeledCount}`,
    }));
}

/**
 * Lists the available microphones. Call again after the user grants
 * microphone permission (e.g. once a recording has started) to pick up real
 * device labels in place of the "マイク N" placeholders.
 */
export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return toAudioInputDevices(devices);
}

/**
 * Subscribes to device changes (plugging in/removing a microphone). Returns
 * an unsubscribe function.
 */
export function onAudioDeviceChange(callback: () => void): () => void {
  navigator.mediaDevices.addEventListener("devicechange", callback);
  return () => navigator.mediaDevices.removeEventListener("devicechange", callback);
}
