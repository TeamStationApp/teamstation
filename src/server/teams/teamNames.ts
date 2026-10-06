/**
 * The one rule TeamStation has for whether a schedule names a team it holds.
 *
 * A name finds a team only when the two are the same once trimmed, with runs
 * of spaces collapsed and case ignored. Anything looser — a trailing number,
 * a bracketed note, punctuation, a coach's surname — is a different name
 * here: a client that knows two spellings are one team says so by sending
 * the team's id.
 */

/** A team name as names are compared: trimmed, spaces collapsed, any case. */
export function teamNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Whether a name says a game's opponent is not known yet — `TBD`, `TBA`,
 * `To be decided`, `To be announced`, `To be determined`, followed by
 * anything, such as a date. Such a name names no team.
 */
export function isUndeterminedName(name: string): boolean {
  return /^(tbd|tba|to be (decided|announced|determined))\b/i.test(name.trim())
}
