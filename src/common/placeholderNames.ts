/**
 * How a game names a player it does not know: the team's name cut short, then
 * a letter. Scoring names its placeholders this way, and the server names a
 * player whose part in a game was withdrawn the same way, so the two read
 * alike in a box score.
 */

/**
 * The only abbreviation policy for a team or venue name: a roster
 * placeholder's prefix, and a schedule preview's field label. Length includes
 * spaces. Always in capitals, so a shortened name reads as one, whatever the
 * case it was typed in.
 */
export function placeholderTeamName(name: string): string {
  return abbreviated(name).toUpperCase()
}

function abbreviated(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  while (words[0]?.toLowerCase() === 'the') words.shift()
  const selected = words.slice(0, 3)
  const full = selected.join(' ')
  if (full === '') return 'Team'
  if (full.length <= 10) return full
  const shortened = full
    .replace(/[aeiou]/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (shortened === '') return 'Team'
  if (shortened.length <= 8) return shortened
  if (words.length > 2)
    return selected
      .map(word => word[0])
      .join('')
      .toUpperCase()
  const result = (
    selected.length === 2
      ? selected[0][0] + selected[1].replace(/[aeiou]/gi, '')
      : shortened
  ).slice(0, 8)
  return result === '' ? 'Team' : result
}
export function placeholderSuffix(index: number): string {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  return result
}
