export {
  dictationContext,
  RELEASE_TAIL_MS,
  upcoming,
  useDictation
} from './dictationHook'

/** The dictation socket's address, from the API's base URL. */
export function dictationUrl(
  apiBaseUrl: string,
  location: { protocol: string; host: string } = window.location
): string {
  const absolute = /^https?:\/\//.test(apiBaseUrl)
    ? apiBaseUrl
    : `${location.protocol}//${location.host}${apiBaseUrl.startsWith('/') ? '' : '/'}${apiBaseUrl}`
  return `${absolute.replace(/^http/, 'ws').replace(/\/+$/, '')}/dictation`
}
