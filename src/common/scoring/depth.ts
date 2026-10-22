/**
 * How far a batted ball went, in the words a scorer says it: from a
 * dribbler just past the mound to one off the wall. The scoring screen turns
 * a depth into a spot at the game's own fence distance; a dictation model
 * only ever names the depth.
 */
export const DEPTHS = [
  'shy_of_base',
  'dribbler',
  'infield',
  'past_base',
  'bloop',
  'shallow',
  'medium',
  'deep',
  'warning_track',
  'wall'
] as const
export type Depth = (typeof DEPTHS)[number]

/** The side of the field an uncaught foul went to. */
export const FOUL_SIDES = ['left', 'right'] as const
export type FoulSide = (typeof FOUL_SIDES)[number]

/** The depths an uncaught foul can be placed at. */
export const FOUL_DEPTHS = [
  'shy_of_base',
  'past_base',
  'shallow',
  'deep',
  'warning_track'
] as const satisfies readonly Depth[]

/**
 * The phrases that say a depth outright, longest first within each. A
 * phrase counts only beside a batted-ball or field word (`DEPTH_ANCHORS`),
 * unless it names a base itself.
 */
export const DEPTH_WORDS: Record<Depth, readonly string[]> = {
  shy_of_base: [
    'just shy of first',
    'just shy of third',
    'shy of first',
    'shy of third',
    'short of first',
    'short of third',
    "didn't reach the bag"
  ],
  dribbler: [
    'infield dribbler',
    'swinging bunt',
    'topped it',
    'dribbler',
    'nubber',
    'squibber',
    'tapper',
    'trickler'
  ],
  infield: [
    // Where an infielder played, not how far the ball went.
    'deep to short',
    'deep at short',
    'deep short',
    'deep to second',
    'deep second',
    'deep to third',
    'deep at third',
    'deep third',
    'deep to first',
    'deep in the hole',
    'in the infield',
    'infield popup',
    'infield pop',
    'high chopper',
    'one-hopper',
    'one hopper',
    'in the hole'
  ],
  past_base: [
    'past first base',
    'past third base',
    'beyond the bag',
    'past the bag',
    'past first',
    'past third'
  ],
  bloop: [
    'just over the infielder',
    "no-man's land",
    'texas leaguer',
    'dying quail',
    'duck snort',
    'blooper',
    'bloop',
    'flare'
  ],
  shallow: [
    // Before an outfielder only: in front of the plate is a dribbler's.
    'in front of the outfielder',
    'in front of the left fielder',
    'in front of the center fielder',
    'in front of the right fielder',
    'seeing-eye',
    'seeing eye',
    'short center',
    'short left',
    'short right',
    'shallow'
  ],
  medium: [
    'medium-depth',
    'medium depth',
    'can of corn',
    'routine fly',
    'lazy fly'
  ],
  deep: [
    'over his head',
    'into the corner',
    'into the gap',
    'in the gap',
    'deep'
  ],
  warning_track: [
    'back to the wall',
    'warning track',
    'to the track',
    'on the track',
    'at the track'
  ],
  wall: [
    'off the top of the wall',
    'banged off the fence',
    'high off the wall',
    'off the wall',
    'off the fence',
    'hits the wall',
    'hit the wall'
  ]
}

/**
 * Words that tie a depth phrase to the ball, within two words of it. The
 * names of a batted ball — a dribbler, a bloop, a can of corn — are among
 * them, so they need nothing else beside them.
 */
export const DEPTH_ANCHORS: readonly string[] = [
  'dribbler',
  'nubber',
  'squibber',
  'tapper',
  'trickler',
  'bunt',
  'bloop',
  'blooper',
  'leaguer',
  'quail',
  'snort',
  'corn',
  'hopper',
  'one-hopper',
  'chopper',
  'fly',
  'liner',
  'line',
  'drive',
  'grounder',
  'ground',
  'ball',
  'hit',
  'single',
  'double',
  'triple',
  'foul',
  'pop',
  'popup',
  'flare',
  'shot',
  'rope',
  'left',
  'center',
  'right',
  'field',
  'outfield',
  'gap',
  'corner',
  'track',
  'wall',
  'fence',
  'infield',
  'mound',
  'hole',
  'bag',
  'base',
  'first',
  'second',
  'third'
]
