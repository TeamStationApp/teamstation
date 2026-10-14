/** Browsers without this preference retain the shared material fallback. */
export function watchReducedTransparency(
  accept: (reduced: boolean) => void
): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    accept(false)
    return () => {}
  }
  const query = window.matchMedia('(prefers-reduced-transparency: reduce)')
  const change = (): void => {
    accept(query.matches)
  }
  change()
  query.addEventListener('change', change)
  return () => {
    query.removeEventListener('change', change)
  }
}
