/**
 * The web's network watch, which watches nothing: the browser keeps no
 * outbox to wake. The phone's is `reachability.native.ts`.
 */
export function watchReachability(_onReachable: () => void): () => void {
  return () => undefined
}
