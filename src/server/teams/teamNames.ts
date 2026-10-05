/**
 * The rules that say two spellings of a team name are one team.
 *
 * A schedule names an opponent only by a name, and different teams write the
 * same club differently, so these are how a schedule's opponent lands on the
 * team TeamStation already holds.
 */

/**
 * The coach's surname inside a team name, which is how a schedule tells two
 * clubs of the same name apart — and often the only thing two naming schemes
 * share. An organisation calls a team `Bay Stars (Mize)`; another team's
 * schedule calls the same team `NP3 Mize`.
 */
export function coachSurname(name: string): string | undefined {
  const bracketed = /\(([^)]+)\)\s*$/.exec(name)
  const candidate =
    bracketed != null ? bracketed[1] : (name.trim().split(/\s+/).pop() ?? '')
  const word = candidate.trim()
  // A surname, not a number or a two-letter code.
  if (!/^[A-Za-z][A-Za-z'-]{2,}$/.test(word)) return undefined
  return word.toLowerCase()
}

/** Two spellings of the same opponent should be one team. */
export function normaliseTeamName(name: string): string {
  return (
    name
      .toLowerCase()
      // A trailing qualifier a scorekeeper added: "Mid City 1", "Sunshine 2".
      .replace(/\s+\d+$/, '')
      // Notes a video title carried in, not part of the name.
      .replace(/\s*[-–]\s*livestream$/, '')
      .replace(/\s*\((partial|livestream)\)$/, '')
      // A coach's surname in brackets disambiguates two clubs, and it is still
      // the same club: "Bay Stars (Mize)".
      .replace(/\s*\([^)]*\)$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  )
}

/**
 * Whether a name says a game's opponent is not known yet — `TBD`, `TBA`,
 * `To be decided`, `To be announced`, `To be determined`, followed by
 * anything, such as a date. Such a name names no team.
 */
export function isUndeterminedName(name: string): boolean {
  return /^(tbd|tba|to be (decided|announced|determined))\b/i.test(name.trim())
}
