/**
 * `expo-asset` and `expo-file-system`, as far as `@react-three/fiber/native`
 * reaches for them.
 *
 * Fiber imports both at load time to patch three's `TextureLoader` and
 * `FileLoader`, so that a texture or a model can be fetched by URL. The field
 * draws every surface from data it computes and loads nothing by URL except a
 * team's logo, which `useTeamLogo` already treats as optional. So instead of
 * installing two more Expo packages, `metro.config.js` points both names here,
 * and a load by URL fails — the dugout shows no logo — rather than the app
 * failing to start. See src2/MOBILE.md.
 */
function unavailable() {
  return Promise.reject(
    new Error('Loading files by URL is not available in the phone field.')
  )
}

class Asset {
  static fromModule() {
    return { downloadAsync: unavailable }
  }
}

module.exports = {
  Asset,
  cacheDirectory: null,
  EncodingType: { Base64: 'base64' },
  copyAsync: unavailable,
  readAsStringAsync: unavailable,
  writeAsStringAsync: unavailable
}
