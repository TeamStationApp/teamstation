import type { TimedRequest } from '../../common/api'

/**
 * The web's requests for a timed read: none, so `fetch` sends it, as a
 * browser's streams its answer's body. The phone's is
 * `timedRequests.native.ts`.
 */
export const timedRequest: (() => TimedRequest) | undefined = undefined
