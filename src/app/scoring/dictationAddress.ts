/**
 * The dictation socket's address on a phone.
 *
 * The web app can say `/api/v1` and mean the page it was served from. A phone
 * was served from nowhere, so the address has to be absolute — the same base
 * the rest of the app already uses.
 */
export function phoneDictationUrl(apiBaseUrl: string): string {
  if (!/^https?:\/\//.test(apiBaseUrl)) {
    throw new Error('Dictation on the phone needs an absolute API address')
  }
  return `${apiBaseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/dictation`
}
