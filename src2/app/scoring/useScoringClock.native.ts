/** Native scoring remains unavailable until it has a renderer. */
export function useScoringClock(..._args: unknown[]): () => void {
  return () => undefined
}
