/**
 * User agents of the shapes TeamStation's sign-ins send, for the tests that
 * read a device from one. Versions are made up; only the shape matters.
 */
export const userAgents = {
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iPadSafari:
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  /** Chrome's reduced agent: every Android phone is `K`. */
  androidChromeReduced:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  /** An agent that still names its model. */
  androidWithModel:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.000000.000) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  linuxFirefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  /** React Native on iOS and tvOS. */
  nativeApple: 'TeamStation/1 CFNetwork/1500.0.0 Darwin/24.0.0',
  /** React Native on Android. */
  nativeAndroid: 'okhttp/4.12.0',
  curl: 'curl/8.7.1'
} as const
