/**
 * The microphone of a page under test, for dictation end to end: the page's
 * own `getUserMedia`, replaced with a stream that is silent until the test
 * plays a clip into it, which it does once the button is held. Chrome's
 * fake-device flags are not used: on macOS Chrome never resolves
 * `getUserMedia` with them. Everything after the stream — the AudioWorklet,
 * the PCM, the socket, the server, the recogniser — is the real path.
 *
 * Install it before the page loads, with the clip as a base64 WAV:
 *
 *   await page.evaluateOnNewDocument(fakeMicrophone, wavBase64)
 *
 * `window.__playClip()` plays that clip into the microphone opened last and
 * resolves when it has finished; `window.__playClip(otherBase64)` plays
 * another, so one page can say several sentences, on several microphones.
 *
 * It runs in the page, so it is plain script: no `?.` or `??`, which sucrase
 * turns into helpers the page does not have.
 */
export function fakeMicrophone(wavBase64: string): void {
  const decode = (base64: string): Uint8Array =>
    Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const bytes = decode(wavBase64)
  const context = new AudioContext()
  // Each open is a stream of its own, as a real microphone's is: closing
  // dictation stops its stream's tracks, and the next open must still hear.
  let destination = context.createMediaStreamDestination()
  ;(window as any).__playClip = async (other?: string) => {
    await context.resume()
    const clip = other === undefined ? bytes : decode(other)
    const buffer = await context.decodeAudioData(clip.buffer.slice(0))
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(destination)
    await new Promise(resolve => {
      source.onended = resolve
      source.start()
    })
  }
  navigator.mediaDevices.getUserMedia = async () => {
    destination = context.createMediaStreamDestination()
    return destination.stream
  }
}
