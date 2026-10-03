/**
 * Where the microphone button is drawn. The web app, the iPhone and Android
 * share it. Anything else has no microphone path, so the button stays off.
 */
export function dictationOn(platform: string): boolean {
  return platform === 'web' || platform === 'ios' || platform === 'android'
}
