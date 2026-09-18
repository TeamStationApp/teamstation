/**
 * `Alta Hawks` → `AH`, for the tile shown when there is no picture.
 *
 * One implementation, because there were two: the home screen split on spaces
 * and hyphens, the account screen on spaces alone, so `Miller-Reed` came out
 * `MR` in one place and `M` in the other for the same person.
 *
 * Two letters, never three: a tile is a fixed square and a third letter either
 * shrinks the type or spills out of it. `de la Cruz` is `DL` rather than `DC`
 * for the same reason a name is read left to right — guessing which words are
 * the important ones is how `Van Der Berg` becomes `VB` on one screen.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s-]+/)
    // A word has to start with a letter or a digit to have an initial.
    // `Badgers (Ripken)` was coming out `B(`, because a bracket is the first
    // character of a word as far as a split on spaces is concerned.
    .map(word => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(word => word.length > 0)
  return words
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('')
}
