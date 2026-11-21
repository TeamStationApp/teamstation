/**
 * The web's network watch, which watches nothing: the browser has no
 * reachability signal the outbox can use, so the web's queue sends at its
 * next backoff wake or on the first read that succeeds. The phone's is
 * `reachability.native.ts`.
 */
export function watchReachability(_onReachable: () => void): () => void {
  return () => undefined
}
