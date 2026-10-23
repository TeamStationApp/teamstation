/**
 * The kinds of pitch a scorer can name, each with what Gumbo writes for it
 * in a pitch event's `details.type`: MLB's code and its description. The descriptions are the
 * ones Gumbo's pitch events carry (`reference/feed776258.json`); the codes no
 * game in that feed threw take MLB's pitch type list
 * (`reference/pitchTypes.json`).
 */
export const PITCH_TYPES = {
  fastball: { code: 'FA', description: 'Fastball' },
  four_seam: { code: 'FF', description: 'Four-Seam Fastball' },
  sinker: { code: 'SI', description: 'Sinker' },
  cutter: { code: 'FC', description: 'Cutter' },
  slider: { code: 'SL', description: 'Slider' },
  sweeper: { code: 'ST', description: 'Sweeper' },
  slurve: { code: 'SV', description: 'Slurve' },
  curveball: { code: 'CU', description: 'Curveball' },
  knuckle_curve: { code: 'KC', description: 'Knuckle Curve' },
  slow_curve: { code: 'CS', description: 'Slow Curve' },
  changeup: { code: 'CH', description: 'Changeup' },
  splitter: { code: 'FS', description: 'Splitter' },
  forkball: { code: 'FO', description: 'Forkball' },
  screwball: { code: 'SC', description: 'Screwball' },
  knuckleball: { code: 'KN', description: 'Knuckleball' },
  eephus: { code: 'EP', description: 'Eephus Pitch' }
} as const
/**
 * A kind of pitch by name, as an action and a dictation model say it. The
 * model never sees MLB's two-letter codes, which read like its player tags.
 */
export type PitchType = keyof typeof PITCH_TYPES
export const PITCH_TYPE_NAMES = Object.keys(PITCH_TYPES) as PitchType[]
/** The codes Gumbo's pitch events carry for them. */
export const PITCH_TYPE_CODES: readonly string[] = PITCH_TYPE_NAMES.map(
  name => PITCH_TYPES[name].code
)

/** Whether a stored pitch's `details.type` code is one TeamStation writes. */
export function isPitchTypeCode(raw: unknown): boolean {
  return typeof raw === 'string' && PITCH_TYPE_CODES.includes(raw)
}

/**
 * Cleans a named kind of pitch. An unknown one is dropped rather than
 * refused, so a sentence or a saved play that holds one still stands: the
 * pitch is thrown without a kind.
 */
export function asPitchType(raw: unknown): PitchType | undefined {
  return typeof raw === 'string' && Object.hasOwn(PITCH_TYPES, raw)
    ? (raw as PitchType)
    : undefined
}

/** Gumbo's `details.type` for a pitch of this kind: MLB's code and words. */
export function pitchTypeOf(name: PitchType): {
  code: string
  description: string
} {
  return { ...PITCH_TYPES[name] }
}

/** The words a scorer names each kind of pitch by. */
const PITCH_TYPE_SAID: Record<PitchType, RegExp> = {
  fastball: /\b(?:fast ?ball|heater|gas|cheese|number one)\b/i,
  four_seam: /\b(?:four[\s-]?seam(?:er)?|riser)\b/i,
  sinker: /\b(?:sinker|two[\s-]?seam(?:er)?|sinking fast ?ball)\b/i,
  cutter: /\b(?:cutter|cut (?:fast ?)?ball)\b/i,
  slider: /\bslider\b/i,
  sweeper: /\bsweeper\b/i,
  slurve: /\bslurve\b/i,
  curveball:
    /\b(?:curve(?:ball)?|hook|yakker|bender|uncle charlie|twelve[\s-]to[\s-]six|12[\s-]to[\s-]6)\b/i,
  knuckle_curve: /\b(?:knuckle[\s-]?curve(?:ball)?|spike curve)\b/i,
  slow_curve: /\bslow curve(?:ball)?\b/i,
  // A change, not a pitching, lineup or defensive change.
  changeup:
    /(?<!\b(?:pitching|lineup|defensive)\s)\bchange(?:[\s-]?up)?\b|\boff[\s-]?speed\b/i,
  splitter: /\b(?:splitter|splitty|split[\s-]?finger(?:ed)?)\b/i,
  forkball: /\bfork ?ball\b/i,
  screwball: /\b(?:screw ?ball|scroogie)\b/i,
  knuckleball: /\b(?:knuckle ?ball|knuckler)\b/i,
  eephus: /\b(?:eephus|blooper pitch)\b/i
}

/** Whether the words name this kind of pitch. */
export function pitchTypeSaid(name: PitchType, words: string): boolean {
  return PITCH_TYPE_SAID[name].test(words)
}

/** Whether the words name any kind of pitch. */
export function namesPitchType(words: string): boolean {
  return PITCH_TYPE_NAMES.some(name => pitchTypeSaid(name, words))
}
