/**
 * The tile a team without a logo is drawn with: two capital letters on a
 * colour of its own.
 */

/**
 * `Badgers (Ripken)` → `BR`, `Badgers` → `BA`.
 *
 * The first letter of each of the first two words; a name of one word gives
 * its first two letters, so a one-word team still fills the tile. Anything
 * that is not a letter or a digit — brackets, full stops, apostrophes — is
 * dropped first, so it can neither be an initial nor make a word of its own.
 *
 * Not `initialsOf`, which is a person's: a person called `Paul` is `P`.
 */
export function teamInitialsOf(name: string): string {
  const words = name
    .split(/[\s-]+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(word => word.length > 0)
  const letters =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2).join('')
      : words
          .slice(0, 2)
          .map(word => Array.from(word)[0])
          .join('')
  return letters.toUpperCase()
}

/**
 * Thirty-two colours a tile can be, each dark enough under white letters to read
 * at 4.5:1 or better.
 */
export const TEAM_TINTS = [
  '#B91C1C', // red
  '#C2410C', // orange
  '#B45309', // amber
  '#15803D', // green
  '#0F766E', // teal
  '#1D4ED8', // blue
  '#6D28D9', // violet
  '#BE185D', // pink
  '#991B1B',
  '#9A3412',
  '#92400E',
  '#166534',
  '#115E59',
  '#1E40AF',
  '#5B21B6',
  '#9D174D',
  '#7F1D1D',
  '#7C2D12',
  '#78350F',
  '#14532D',
  '#134E4A',
  '#1E3A8A',
  '#4C1D95',
  '#831843',
  '#9F1239',
  '#854D0E',
  '#3F6212',
  '#065F46',
  '#155E75',
  '#075985',
  '#3730A3',
  '#86198F'
] as const

/**
 * The colour of a team's tile.
 *
 * Picked by a hash of the team's trimmed name, so it is
 * the same for a team on every visit, every screen, and every platform. A
 * rename may change it.
 */
export function teamTint(key: string): string {
  // 32-bit FNV-1a.
  let hash = 0x811c9dc5
  for (const unit of Array.from(key.trim())) {
    const code = unit.codePointAt(0) ?? 0
    hash ^= code
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return TEAM_TINTS[hash % TEAM_TINTS.length]
}
