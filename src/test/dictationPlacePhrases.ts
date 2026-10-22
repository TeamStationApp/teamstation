import type { Direction } from '../common/scoring/actions'
import type { Depth, FoulSide } from '../common/scoring/depth'
import type { PitchLocation } from '../common/scoring/pitchLocation'
import type { PitchType } from '../common/scoring/pitchType'

/**
 * Sentences that say where a ball or a pitch went, and the tool calls each
 * must come to: two for every depth (one of them with no direction), every
 * foul place, every pitch location and every kind of pitch. The prompt cases
 * check the model's calls; the distance cases put them through the scoring
 * screen and check what is stored, in feet at the default 200 ft fence.
 */
export type PlacePhrase =
  | {
      kind: 'ball'
      said: string
      depth?: Depth
      distanceFeet?: number
      direction?: Direction
      /** Feet stored for the ball at a 200 ft fence, inclusive. */
      feet: [number, number]
    }
  | {
      kind: 'foul'
      said: string
      direction: FoulSide
      depth: Depth
    }
  | {
      kind: 'pitch'
      said: string
      call: 'B' | 'C' | 'S' | 'F'
      location?: Partial<PitchLocation>
      /** null: the words name no kind, so none is sent. */
      pitchType?: PitchType | null
    }

const band = (feet: number): [number, number] => [feet - 12, feet + 12]

export const ballPhrases: PlacePhrase[] = [
  {
    kind: 'ball',
    said: 'Infield dribbler, the pitcher throws him out.',
    depth: 'dribbler',
    feet: band(41)
  },
  {
    kind: 'ball',
    said: 'A little nubber up the line, he beats it out for a single.',
    depth: 'dribbler',
    feet: band(41)
  },
  {
    kind: 'ball',
    said: 'One-hopper to short, thrown out at first.',
    depth: 'infield',
    feet: band(64)
  },
  {
    kind: 'ball',
    said: 'Ground ball deep in the hole, the shortstop throws him out.',
    depth: 'infield',
    feet: band(64)
  },
  {
    kind: 'ball',
    said: 'Grounder just shy of first, the first baseman takes it to the bag.',
    depth: 'shy_of_base',
    feet: band(40)
  },
  {
    kind: 'ball',
    said: 'Bunt that stops short of third, thrown out.',
    depth: 'shy_of_base',
    feet: band(40)
  },
  {
    kind: 'ball',
    said: 'Ground ball past first base into right, single.',
    depth: 'past_base',
    feet: band(61)
  },
  {
    kind: 'ball',
    said: 'Hard grounder past third, double down the line.',
    depth: 'past_base',
    feet: band(61)
  },
  {
    kind: 'ball',
    said: 'Bloop single to center.',
    depth: 'bloop',
    direction: 'center',
    feet: band(90)
  },
  {
    kind: 'ball',
    said: 'Bloop single to shallow center.',
    depth: 'shallow',
    direction: 'center',
    feet: band(110)
  },
  {
    kind: 'ball',
    said: 'A Texas leaguer that falls in for a single.',
    depth: 'bloop',
    feet: band(90)
  },
  {
    kind: 'ball',
    said: 'Flies out to shallow left.',
    depth: 'shallow',
    direction: 'left',
    feet: band(110)
  },
  {
    kind: 'ball',
    said: 'Single, a soft liner that drops in the shallow outfield.',
    depth: 'shallow',
    feet: band(110)
  },
  {
    kind: 'ball',
    said: 'Can of corn to center, caught.',
    depth: 'medium',
    direction: 'center',
    feet: band(139)
  },
  {
    kind: 'ball',
    said: 'Routine fly ball, caught by the center fielder.',
    depth: 'medium',
    feet: band(139)
  },
  {
    kind: 'ball',
    said: 'Deep fly to right, caught.',
    depth: 'deep',
    direction: 'right',
    feet: band(178)
  },
  {
    kind: 'ball',
    said: 'Line drive over his head, double.',
    depth: 'deep',
    feet: band(178)
  },
  {
    kind: 'ball',
    said: 'Deep fly to right, caught at the warning track.',
    depth: 'warning_track',
    direction: 'right',
    feet: band(190)
  },
  {
    kind: 'ball',
    said: 'Fly ball back to the track, the left fielder makes the catch.',
    depth: 'warning_track',
    feet: band(190)
  },
  {
    kind: 'ball',
    said: 'Line drive off the wall in left center, double.',
    depth: 'wall',
    direction: 'left_center',
    feet: band(200)
  },
  {
    kind: 'ball',
    said: 'Fly ball off the fence, double.',
    depth: 'wall',
    feet: band(200)
  },
  {
    kind: 'ball',
    said: 'A 160-foot fly to center, caught.',
    distanceFeet: 160,
    direction: 'center',
    feet: band(160)
  },
  {
    kind: 'ball',
    said: 'Line drive, 120 feet to left, single.',
    distanceFeet: 120,
    direction: 'left',
    feet: band(120)
  }
]

export const foulPhrases: PlacePhrase[] = [
  {
    kind: 'foul',
    said: 'He fouls it off, just shy of first.',
    direction: 'right',
    depth: 'shy_of_base'
  },
  {
    kind: 'foul',
    said: 'Foul pop shy of third, nobody gets to it.',
    direction: 'left',
    depth: 'shy_of_base'
  },
  {
    kind: 'foul',
    said: 'Foul ball past third base.',
    direction: 'left',
    depth: 'past_base'
  },
  {
    kind: 'foul',
    said: 'Fouled back past first, out of play.',
    direction: 'right',
    depth: 'past_base'
  },
  {
    kind: 'foul',
    said: 'Foul ball deep into the right field seats.',
    direction: 'right',
    depth: 'deep'
  },
  {
    kind: 'foul',
    said: 'Long foul fly, deep down the left field line.',
    direction: 'left',
    depth: 'deep'
  }
]

export const pitchPhrases: PlacePhrase[] = [
  {
    kind: 'pitch',
    said: 'Misses high and inside.',
    call: 'B',
    location: { height: 'high', side: 'inside', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'Up and in, it misses, ball one.',
    call: 'B',
    location: { height: 'high', side: 'inside', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'Low and inside, in the zone.',
    call: 'C',
    location: { height: 'low', side: 'inside', inZone: true }
  },
  {
    kind: 'pitch',
    said: "Low and in, but it's in the zone, strike.",
    call: 'C',
    location: { height: 'low', side: 'inside', inZone: true }
  },
  {
    kind: 'pitch',
    said: 'Right down the middle for a strike.',
    call: 'C',
    location: { height: 'middle', side: 'middle', inZone: true }
  },
  {
    kind: 'pitch',
    said: 'Grooved one down the middle, called strike.',
    call: 'C',
    location: { height: 'middle', side: 'middle', inZone: true }
  },
  {
    kind: 'pitch',
    said: 'High and away, ball.',
    call: 'B',
    location: { height: 'high', side: 'away', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'Up and away, misses.',
    call: 'B',
    location: { height: 'high', side: 'away', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'Just outside, ball.',
    call: 'B',
    location: { side: 'away', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'Just off the outside corner, ball.',
    call: 'B',
    location: { side: 'away', inZone: false }
  },
  {
    kind: 'pitch',
    said: 'In the zone, he takes it for a strike.',
    call: 'C',
    location: { inZone: true }
  },
  {
    kind: 'pitch',
    said: 'A pitch in the zone, called strike.',
    call: 'C',
    location: { inZone: true }
  },
  {
    kind: 'pitch',
    said: 'Fastball, misses high and inside.',
    call: 'B',
    pitchType: 'fastball'
  },
  {
    kind: 'pitch',
    said: 'Heater, swing and a miss.',
    call: 'S',
    pitchType: 'fastball'
  },
  {
    kind: 'pitch',
    said: 'Four-seamer up, ball.',
    call: 'B',
    pitchType: 'four_seam'
  },
  {
    kind: 'pitch',
    said: 'Four-seam fastball, fouled back.',
    call: 'F',
    pitchType: 'four_seam'
  },
  { kind: 'pitch', said: 'Sinker low, ball.', call: 'B', pitchType: 'sinker' },
  {
    kind: 'pitch',
    said: 'Two-seamer, called strike.',
    call: 'C',
    pitchType: 'sinker'
  },
  {
    kind: 'pitch',
    said: 'Cutter in on the hands, fouled off.',
    call: 'F',
    pitchType: 'cutter'
  },
  {
    kind: 'pitch',
    said: 'Cut fastball, called strike.',
    call: 'C',
    pitchType: 'cutter'
  },
  {
    kind: 'pitch',
    said: 'Slider in the dirt, he swings and misses.',
    call: 'S',
    pitchType: 'slider'
  },
  {
    kind: 'pitch',
    said: 'Slider outside, ball.',
    call: 'B',
    pitchType: 'slider'
  },
  {
    kind: 'pitch',
    said: 'Sweeper, swing and a miss.',
    call: 'S',
    pitchType: 'sweeper'
  },
  {
    kind: 'pitch',
    said: 'Sweeper away, ball.',
    call: 'B',
    pitchType: 'sweeper'
  },
  {
    kind: 'pitch',
    said: 'Slurve, called strike.',
    call: 'C',
    pitchType: 'slurve'
  },
  {
    kind: 'pitch',
    said: 'Slurve in the dirt, ball.',
    call: 'B',
    pitchType: 'slurve'
  },
  {
    kind: 'pitch',
    said: 'Curveball, called strike.',
    call: 'C',
    pitchType: 'curveball'
  },
  {
    kind: 'pitch',
    said: 'Uncle Charlie, he swings over it.',
    call: 'S',
    pitchType: 'curveball'
  },
  {
    kind: 'pitch',
    said: 'Knuckle curve, called strike.',
    call: 'C',
    pitchType: 'knuckle_curve'
  },
  {
    kind: 'pitch',
    said: 'Knuckle curve bounces, ball.',
    call: 'B',
    pitchType: 'knuckle_curve'
  },
  {
    kind: 'pitch',
    said: 'Slow curve, he takes it for a strike.',
    call: 'C',
    pitchType: 'slow_curve'
  },
  {
    kind: 'pitch',
    said: 'Slow curve misses low.',
    call: 'B',
    pitchType: 'slow_curve'
  },
  {
    kind: 'pitch',
    said: 'Changeup, swing and a miss.',
    call: 'S',
    pitchType: 'changeup'
  },
  {
    kind: 'pitch',
    said: 'Something off-speed, low, ball.',
    call: 'B',
    pitchType: 'changeup'
  },
  {
    kind: 'pitch',
    said: 'Splitter, swinging strike.',
    call: 'S',
    pitchType: 'splitter'
  },
  {
    kind: 'pitch',
    said: 'Split-finger in the dirt, ball.',
    call: 'B',
    pitchType: 'splitter'
  },
  {
    kind: 'pitch',
    said: 'Forkball, he swings and misses.',
    call: 'S',
    pitchType: 'forkball'
  },
  {
    kind: 'pitch',
    said: 'Forkball low, ball.',
    call: 'B',
    pitchType: 'forkball'
  },
  {
    kind: 'pitch',
    said: 'Screwball, called strike.',
    call: 'C',
    pitchType: 'screwball'
  },
  {
    kind: 'pitch',
    said: 'Screwball inside, ball.',
    call: 'B',
    pitchType: 'screwball'
  },
  {
    kind: 'pitch',
    said: 'Knuckleball, called strike.',
    call: 'C',
    pitchType: 'knuckleball'
  },
  {
    kind: 'pitch',
    said: 'Knuckler, fouled off.',
    call: 'F',
    pitchType: 'knuckleball'
  },
  {
    kind: 'pitch',
    said: 'Eephus, he takes it for a ball.',
    call: 'B',
    pitchType: 'eephus'
  },
  {
    kind: 'pitch',
    said: 'An eephus pitch, called strike.',
    call: 'C',
    pitchType: 'eephus'
  },
  {
    kind: 'pitch',
    said: 'Breaking ball, swinging strike.',
    call: 'S',
    pitchType: null
  },
  {
    kind: 'pitch',
    said: 'A breaking ball outside, ball.',
    call: 'B',
    pitchType: null
  }
]

export const placePhrases: PlacePhrase[] = [
  ...ballPhrases,
  ...foulPhrases,
  ...pitchPhrases
]
