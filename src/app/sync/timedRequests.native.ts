import type { TimedRequest } from '../../common/api'

/**
 * The phone's request for a timed read, an `XMLHttpRequest`: React Native's
 * `fetch` settles only once the whole body has come, so its deadline would
 * cover the download too (`ClientOptions.timedRequest`).
 */
export const timedRequest: () => TimedRequest = () =>
  new XMLHttpRequest() as unknown as TimedRequest
