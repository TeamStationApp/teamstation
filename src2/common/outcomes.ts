/**
 * What one player did on a play, in two or three words.
 *
 * The highlighter already writes a line for every credited outcome — `Single:
 * Jensen P`, `Ground out: Jensen P (SS) to Wesley B (1B)`, `Run: Harlow P` —
 * and that wording is shared with the chapter titles GS Distributor writes, so
 * a play reads the same everywhere. On a player's own page the name is the one
 * thing the reader already knows, and a list that says it back forty times is
 * a list of one name.
 *
 * So this takes the same outcome and says only what was done. It works from
 * the engine's own label rather than inventing a second vocabulary: the head
 * of the label — everything before the colon — is the outcome, which is why
 * `Caught stealing 2nd` and `Out at 3rd` come through with the base intact
 * without this file knowing what a base is.
 */
export interface CreditedOutcomeLike {
  eventType: string
  /** `Single: Jensen P`. */
  label: string
  credit: { role: string } | null
}

/** The few where the event type alone reads better than the label's head. */
const BY_TYPE: Record<string, string> = {
  run: 'Run scored',
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home run',
  walk: 'Walk',
  intent_walk: 'Intentional walk',
  hit_by_pitch: 'Hit by pitch',
  sac_fly: 'Sacrifice fly',
  sac_bunt: 'Sacrifice bunt',
  double_play: 'Double play'
}

export function outcomeName(outcome: CreditedOutcomeLike): string {
  const role = outcome.credit?.role ?? ''

  // A strikeout belongs to whoever is credited with it, and the two readings
  // are opposite sides of the same play: the pitcher earned it, the catcher
  // picked up a dropped third strike.
  if (outcome.eventType === 'strikeout') {
    return role === 'pitcher' ? 'Strikeout pitching' : 'Dropped third strike'
  }

  const known = BY_TYPE[outcome.eventType]
  if (known != null) return known

  return headOf(outcome.label)
}

/** `Ground out: Jensen P (SS) to Wesley B (1B)` → `Ground out`. */
function headOf(label: string): string {
  const head = label.split(':')[0].trim()
  return head === '' ? 'Play' : head
}
