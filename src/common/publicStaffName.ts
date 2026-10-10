/** Public display is computed before serialization; full names never leave this function. */
export function publicStaffName(person: {
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
}): string {
  const safe = (value: string | null | undefined): string => value?.trim() ?? ''
  const fallback = safe(person.displayName)
  const parts = fallback.includes('@')
    ? []
    : fallback.split(/\s+/).filter(Boolean)
  const suppliedFirst = safe(person.firstName)
  const first = suppliedFirst !== '' ? suppliedFirst : (parts[0] ?? '')
  if (first === '' || first.includes('@')) return 'Staff member'
  const suppliedLast = safe(person.lastName)
  const last =
    suppliedLast !== ''
      ? suppliedLast
      : parts.length > 1
        ? parts[parts.length - 1]
        : ''
  const initial = [
    ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(last)
  ][0]?.segment
  return initial == null ? first : `${first} ${initial}.`
}
