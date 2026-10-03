/** The bearer header a phone sends because it has no session cookie. */
export function dictationHeaders(
  token: string | undefined
): Record<string, string> | undefined {
  if (token == null || token === '') return undefined
  return { Authorization: `Bearer ${token}` }
}
