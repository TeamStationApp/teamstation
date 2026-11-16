/**
 * Text that `LIKE` and `ILIKE` read as itself: its `%`, `_` and `\` escaped,
 * so a search for `50%` finds that and not everything starting `50`.
 */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}
