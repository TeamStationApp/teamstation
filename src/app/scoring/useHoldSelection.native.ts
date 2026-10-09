/** Native Pressability owns touch cancellation without document selection. */
export function useHoldSelection(): {
  onPressIn?: () => void
  onPressOut?: () => void
  onLongPress?: () => void
} {
  return {}
}
