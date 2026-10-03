/**
 * Where the microphone button is drawn. The web app and the iPhone share it.
 * Android has no microphone module, so the button stays off there.
 */
export function dictationOn(platform: string): boolean {
  return platform === 'web' || platform === 'ios'
}
