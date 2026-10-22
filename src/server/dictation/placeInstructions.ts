import type { Tool } from '../../common/scoring/actions'
import { DEPTH_WORDS } from '../../common/scoring/depth'
import { namesPitchType } from '../../common/scoring/pitchType'

/**
 * Where a batted ball and a pitch went, in the words announcers use, as the
 * dictation model is to read them: the depth of a ball in play, where an
 * uncaught foul came down, where a pitch crossed the plate, and what kind of
 * pitch it was. Each word is worked at least twice (`PLACE_KEYWORDS`). A
 * sentence is given only the sections its words call for (`placeSections`).
 */
/** Where a batted ball and an uncaught foul went. */
export const BALL_PLACE_INSTRUCTIONS = `WHERE THE BALL WENT
- How far a ball in play went is ballInPlay depth, when the words say it:
  shy_of_base, dribbler, infield, past_base, bloop, shallow, medium, deep,
  warning_track or wall. A distance said in feet is distanceFeet instead.
  Never make a depth up: leave it out when the words give none. A home run
  is its result, however deep it was called: give a home run no depth, and
  no homeRunKind unless the words say inside the park.
  A depth says only how far the ball went, never who fielded it: when the
  words name no fielder, leave the fielder off.
- dribbler: barely past the pitcher. A dribbler, a nubber, a swinging bunt,
  a squibber, a tapper or a trickler.
  "Infield dribbler, the pitcher throws him out." is ballInPlay contact
  swing, trajectory ground_ball, depth dribbler, the pitcher, and result
  field_out with outBy throw.
  "A nubber in front of the plate, the catcher throws him out." is depth
  dribbler, the catcher, result field_out with outBy throw.
  "Swinging bunt, he beats it out for a single." is contact swing, depth
  dribbler, result single. A swinging bunt is a swing, not contact bunt.
  "Little tapper back to the mound, pitcher to first." is depth dribbler,
  the pitcher, result field_out with outBy throw.
  "Squibber up the line, safe at first, single." is depth dribbler, result
  single.
  "A nubber off the end of the bat, a dribbler to third, single." is depth
  dribbler, result single.
  "Squibber to the catcher, he throws him out." is depth dribbler, the
  catcher, result field_out with outBy throw.
  "Tapper to short, thrown out." is depth dribbler, the shortstop, result
  field_out with outBy throw.
  "A swinging bunt down the third base line, thrown out." is contact swing,
  depth dribbler, result field_out with outBy throw.
- infield: on the infield dirt. A one-hopper, a high chopper, a ball in the
  hole, an infield pop.
  "One-hopper to short, thrown out." is trajectory ground_ball, depth
  infield, the shortstop, result field_out with outBy throw.
  "High chopper to third, beats it out." is trajectory chopper, depth
  infield, the third baseman, result single.
  "Grounder deep in the hole, short throws him out." is depth infield, the
  shortstop, result field_out with outBy throw: deep in the hole is still
  the infield.
  "Ground ball deep to short, he throws him out." is depth infield, the
  shortstop, result field_out with outBy throw: deep to short, or deep at
  third, is where the infielder played, never a deep ball.
  "Infield pop to third, caught." is trajectory popup, depth infield, the
  third baseman — third is the base the scorer named — and result field_out
  with outBy catch.
  "One-hopper back to the pitcher, to first." is depth infield, the
  pitcher, result field_out with outBy throw.
  "Infield pop on the left side, caught." is depth infield, direction left,
  result field_out with outBy catch.
  "Ground ball in the hole, single." is depth infield, result single.
  "Grounder in the hole, 6-3." is depth infield, the shortstop — the hole is
  his side, and 6-3 is the shortstop throwing to first — and result
  field_out with outBy throw: the batter is out at first by that result,
  not by a runnerMovement.
  "High chopper over the mound, single up the middle." is trajectory
  chopper, depth infield, direction center, result single.
- shy_of_base and past_base: short of first or third base, or 10 to 20
  feet past it, along its line.
  "Grounder just shy of first, the first baseman steps on the bag." is depth
  shy_of_base, the first baseman, result field_out with outBy throw.
  "Ground ball past first base, into right, single." is depth past_base,
  result single.
  "Bunt short of third, thrown out." is contact bunt, depth shy_of_base,
  result field_out with outBy throw.
  "Hard grounder past third, double down the line." is depth past_base,
  result double.
  "Slow roller short of third, he can't make the play, single." is depth
  shy_of_base, result single.
- bloop: just behind the infield, a short fly that falls in. A bloop, a
  blooper, a Texas leaguer, a flare, a dying quail, a duck snort, a ball in
  no-man's land.
  "Bloop single to center." is trajectory fly_ball, depth bloop, direction
  center, result single.
  "A blooper to right, falls in for a hit." is depth bloop, direction right,
  result single.
  "Texas leaguer to left, single." is depth bloop, direction left, result
  single.
  "Flare to right center, it drops." is depth bloop, direction
  right_center, result single.
  "A dying quail into short left, single." is depth bloop, direction left,
  result single.
  "Duck snort over second, falls in." is depth bloop, direction center,
  result single.
  "Pop fly into no-man's land, it drops for a double." is depth bloop,
  result double.
  "Bloop to shallow right, caught by the second baseman." is depth shallow,
  the second baseman, result field_out with outBy catch: when two depths
  are said, the deeper one.
  "A blooper behind first, caught." is depth bloop, result field_out with
  outBy catch.
  "A Texas leaguer down the line in right." is depth bloop, direction right.
  "Flare to left field, dropped in." is depth bloop, direction left, result
  single.
  "Dying quail to center, caught." is depth bloop, direction center, result
  field_out with outBy catch.
  "A duck snort to right, single." is depth bloop, direction right, result
  single.
  "No-man's land in short center, it drops." is depth bloop, direction
  center, result single.
- shallow: the shallow outfield, a little past a bloop. Shallow left,
  center or right, short center, in front of the outfielder, a seeing-eye
  single.
  "Flies out to shallow left." is trajectory fly_ball, depth shallow,
  direction left, result field_out with outBy catch.
  "Line drive to shallow center, single." is trajectory line_drive, depth
  shallow, direction center, result single.
  "Seeing-eye single through the right side." is trajectory ground_ball,
  depth shallow, direction right, result single.
  "Pop fly to short center, caught in front of the outfielder." is depth
  shallow, direction center, result field_out with outBy catch.
  "Line drive that drops in front of the outfielder in left, single." is
  depth shallow, direction left, result single.
  "A seeing-eye grounder up the middle into center." is trajectory
  ground_ball, depth shallow, direction center.
  "Shallow fly to right, Casey tags and holds." is depth shallow, direction
  right, result field_out with outBy catch.
- medium: a routine fly. A can of corn, a routine fly, a lazy fly.
  "Can of corn to center." is trajectory fly_ball, depth medium, direction
  center, result field_out with outBy catch.
  "Routine fly to left, caught." is depth medium, direction left, result
  field_out with outBy catch.
  "Lazy fly to right, can of corn." is depth medium, direction right, result
  field_out with outBy catch.
  "A routine fly ball to center field." is depth medium, direction center.
  "Lazy fly to left, caught." is depth medium, direction left, result
  field_out with outBy catch.
- deep: deep in the outfield, just shy of the warning track. Deep, over his
  head, in the gap on a fly, into the corner.
  "Deep fly to right, caught." is trajectory fly_ball, depth deep, direction
  right, result field_out with outBy catch.
  "Line drive over his head in center, double." is trajectory line_drive,
  depth deep, direction center, result double.
  "Drive in the gap in left center, triple." is depth deep, direction
  left_center, result triple.
  "Grounder into the corner in right, double." is depth deep, direction
  right, result double.
  "Deep drive to left center, caught on the run." is depth deep, direction
  left_center, result field_out with outBy catch.
  "A fly ball over his head in left, double." is depth deep, direction left,
  result double.
  "Into the gap in right center, two bases." is depth deep, direction
  right_center, result double.
  "Line drive in the gap in right center, double." is depth deep, direction
  right_center, result double.
  "Fly ball into the gap in left center, caught on the run." is depth deep,
  direction left_center, result field_out with outBy catch.
  "Line drive into the corner in left, double." is depth deep, direction
  left, result double.
- warning_track: on the warning track, 10 feet from the wall. The warning
  track, to the track, on the track, back to the wall for the catch.
  "Deep fly to right, caught at the warning track." is depth warning_track,
  direction right, result field_out with outBy catch: the track is deeper
  than deep.
  "Fly ball to the track in center, caught." is depth warning_track,
  direction center, result field_out with outBy catch.
  "He goes back to the wall in left and makes the catch." is depth
  warning_track, direction left, result field_out with outBy catch.
  "Drive on the track in right center, it drops, double." is depth
  warning_track, direction right_center, result double.
  "Fly to the warning track in left, caught." is depth warning_track,
  direction left, result field_out with outBy catch.
  "Back to the wall, on the track, he catches it in center." is depth
  warning_track, direction center, result field_out with outBy catch.
  "Drive to the track in right, off the glove, double." is depth
  warning_track, direction right, result double.
- wall: off the wall, the ball meeting the fence in the air. Off the wall,
  off the fence, high off the wall, it hits the wall.
  "Line drive off the wall in left center, double." is trajectory
  line_drive, depth wall, direction left_center, result double.
  "Fly ball high off the wall in right, triple." is depth wall, direction
  right, result triple.
  "It hits the wall in center, single." is depth wall, direction center,
  result single.
  "Banged off the fence in left, double." is depth wall, direction left,
  result double.
  "Off the wall in right center, the runner scores, double." is depth wall,
  direction right_center, result double.
  "A drive off the fence in center, triple." is depth wall, direction
  center, result triple.
  "Fly ball hits the wall in left, he holds at first." is depth wall,
  direction left, result single.
- A distance said in feet is distanceFeet, the number of feet.
  "A 300-foot fly to center, caught." is distanceFeet 300, direction center,
  result field_out with outBy catch.
  "Line drive, 250 feet to left, double." is distanceFeet 250, direction
  left, result double.
  "A fly ball 180 feet to right, caught." is distanceFeet 180, direction
  right, result field_out with outBy catch.
- An uncaught foul the scorer places is pitch F with direction left or
  right — the side of the field: the first-base side is right, the
  third-base side left — and depth shy_of_base, past_base, shallow, deep
  or warning_track. A foul he does not place is pitch F alone.
  "Fouled off, just shy of first." is pitch F, direction right, depth
  shy_of_base.
  "Foul ball past third." is pitch F, direction left, depth past_base.
  "Foul ball deep into the right field seats." is pitch F, direction right,
  depth deep.
  "Fouled back past first base, out of play." is pitch F, direction right,
  depth past_base.
  "Foul pop shy of third, nobody gets there." is pitch F, direction left,
  depth shy_of_base.
  "Foul deep down the left field line." is pitch F, direction left, depth
  deep.
  "Fouled to shallow right, it drops foul." is pitch F, direction right,
  depth shallow.
  "Foul fly to the warning track in left." is pitch F, direction left, depth
  warning_track.
  A foul that is caught is the caught foul above, with the same depth on
  its ballInPlay: "Foul pop just shy of first, caught." is ballInPlay depth
  shy_of_base, result field_out with outBy catch and foulCaught true.
  "Foul fly deep to right, caught." is ballInPlay direction right, depth
  deep, result field_out with outBy catch and foulCaught true.`

/** Where a pitch crossed the plate, and the kind of pitch. */
export const PITCH_INSTRUCTIONS = `THE PITCH
For this sentence these readings replace BASEBALL VOCABULARY's for location
words: a location word alone is where the pitch crossed the plate, not a
ball by itself.
- Where a pitch crossed the plate is pitchLocation on the pitch: height
  high, middle or low; side inside, middle or away, from the batter's side;
  inZone whether it was in the strike zone. Outside is away; up is high,
  and in is inside. With no call
  words, a location out of the zone is pitch B, and one in the zone pitch C,
  or S if he swung. "Misses" or "missed" is out of the zone, always a ball.
  "Misses high and inside." is pitch B, pitchLocation high, inside, inZone
  false.
  "Low and inside, in the zone." is pitch C, pitchLocation low, inside,
  inZone true.
  "Right down the middle for a strike." is pitch C, pitchLocation middle,
  middle, inZone true.
  "High and away, ball one." is pitch B, pitchLocation high, away, inZone
  false.
  "Just outside, ball." is pitch B, pitchLocation middle, away, inZone
  false.
  "In the zone, he swings and misses." is pitch S, pitchLocation middle,
  middle, inZone true: he missed the ball, the pitch did not miss the zone.
  "Misses low." is pitch B, pitchLocation low, middle, inZone false.
  "Inside corner, called strike." is pitch C, pitchLocation middle,
  inside, inZone true.
  "Outside, ball two." is pitch B, pitchLocation middle, away, inZone false.
  "High, ball." is pitch B, pitchLocation high, middle, inZone false.
  "Low and away, in the zone, strike." is pitch C, pitchLocation low, away,
  inZone true.
  "Painted the outside corner at the knees." is pitch C, pitchLocation low,
  away, inZone true.
  "Painted the inside corner, strike." is pitch C, pitchLocation middle,
  inside, inZone true.
  "At the knees, down the middle, strike two." is pitch C, pitchLocation
  low, middle, inZone true.
  "High and tight, misses inside." is pitch B, pitchLocation high, inside,
  inZone false.
  "Up and away, misses." is pitch B, pitchLocation high, away, inZone false.
  "Low, in the dirt." is pitch B, pitchLocation low, middle, inZone false.
  "Inside, in on the hands, ball." is pitch B, pitchLocation middle, inside,
  inZone false.
  "Low and away, he swings and misses." is pitch S, pitchLocation low,
  away, inZone false: a location said with a swing is out of the zone
  unless the words put it in.
- The kind of pitch is pitchType, on the pitch or on the ballInPlay he hit:
  fastball for a fastball, heater, gas, cheese or number one; four_seam for
  a four-seamer or riser; sinker for a two-seamer, sinker or sinking
  fastball; cutter for a cutter or cut fastball; slider; sweeper; slurve;
  curveball for a curveball, curve, hook, yakker, bender, Uncle Charlie or
  twelve-to-six; knuckle_curve for a knuckle curve or spike curve;
  slow_curve; changeup for a changeup, change, circle change, change of
  pace or off-speed; splitter for a splitter, split-finger or splitty;
  forkball; screwball; knuckleball for a knuckleball or knuckler; eephus for
  an eephus or blooper pitch. A breaking ball, junk, something soft, or a
  kind none of these names, is no pitchType: leave it out.
  "Fastball, misses high and inside." is pitch B, pitchType fastball,
  pitchLocation high, inside, inZone false.
  "Heater down the middle, called strike." is pitch C, pitchType fastball,
  pitchLocation middle, middle, inZone true.
  "A heater up and in, ball." is pitch B, pitchType fastball.
  "Fastball, fouled back." is pitch F, pitchType fastball.
  "Four-seamer up and away, ball." is pitch B, pitchType four_seam.
  "Four-seamer, swinging strike." is pitch S, pitchType four_seam.
  "Two-seamer, low and inside, in the zone." is pitch C, pitchType sinker.
  "Two-seamer, fouled off." is pitch F, pitchType sinker.
  "Sinker, swinging strike." is pitch S, pitchType sinker.
  "A sinker in the dirt, ball." is pitch B, pitchType sinker.
  "Cutter in on the hands, fouled off." is pitch F, pitchType cutter.
  "Cutter, called strike on the inside corner." is pitch C, pitchType cutter.
  "Slider low and away, he chases, strike." is pitch S, pitchType slider.
  "Slider in the dirt, ball." is pitch B, pitchType slider.
  "Sweeper, swing and a miss." is pitch S, pitchType sweeper.
  "Sweeper outside, ball." is pitch B, pitchType sweeper.
  "Slurve, called strike." is pitch C, pitchType slurve.
  "A slurve that misses low." is pitch B, pitchType slurve.
  "Curveball, called strike three." is pitch C, pitchType curveball.
  "Curveball in the dirt, swinging strike." is pitch S, pitchType curveball.
  "Hook, misses low." is pitch B, pitchType curveball.
  "A big hook, called strike." is pitch C, pitchType curveball.
  "Uncle Charlie, he buckles, strike." is pitch C, pitchType curveball.
  "Uncle Charlie, misses outside." is pitch B, pitchType curveball.
  "Twelve-to-six curve, swinging strike." is pitch S, pitchType curveball.
  "A twelve-to-six that drops in for a strike." is pitch C, pitchType curveball.
  "Curve in the dirt, ball." is pitch B, pitchType curveball.
  "Knuckle curve, called strike." is pitch C, pitchType knuckle_curve.
  "Knuckle curve low, ball." is pitch B, pitchType knuckle_curve.
  "Slow curve, taken for a strike." is pitch C, pitchType slow_curve.
  "A slow curve that misses." is pitch B, pitchType slow_curve.
  "Changeup, swing and a miss." is pitch S, pitchType changeup.
  "Changeup, low, ball." is pitch B, pitchType changeup.
  "Off-speed, low and away, ball." is pitch B, pitchType changeup.
  "Change, fouled off." is pitch F, pitchType changeup.
  "Something off-speed, called strike." is pitch C, pitchType changeup.
  "Splitter in the dirt, swinging strike." is pitch S, pitchType splitter.
  "Splitter, called strike." is pitch C, pitchType splitter.
  "Split-finger, ball low." is pitch B, pitchType splitter.
  "A split-finger, fouled off." is pitch F, pitchType splitter.
  "Forkball, swinging strike." is pitch S, pitchType forkball.
  "A forkball that misses low." is pitch B, pitchType forkball.
  "Screwball, called strike." is pitch C, pitchType screwball.
  "Screwball inside, ball." is pitch B, pitchType screwball.
  "Knuckleball, called strike." is pitch C, pitchType knuckleball.
  "Knuckleball, misses inside." is pitch B, pitchType knuckleball.
  "Knuckler, fouled off." is pitch F, pitchType knuckleball.
  "A knuckler, swinging strike." is pitch S, pitchType knuckleball.
  "Eephus, taken for a ball." is pitch B, pitchType eephus.
  "An eephus, swinging strike." is pitch S, pitchType eephus.
  "Gas, right by him, swinging strike." is pitch S, pitchType fastball.
  "More gas, fouled back." is pitch F, pitchType fastball.
  "Cheese up the ladder, he chases, strike." is pitch S, pitchType fastball.
  "Pure cheese, called strike." is pitch C, pitchType fastball.
  "Number one, fouled off." is pitch F, pitchType fastball.
  "He goes to number one, ball low." is pitch B, pitchType fastball.
  "Riser up and in, ball." is pitch B, pitchType four_seam.
  "A riser, swinging strike." is pitch S, pitchType four_seam.
  "Sinking fastball, ball one." is pitch B, pitchType sinker.
  "Sinking fastball, called strike." is pitch C, pitchType sinker.
  "Cut fastball, fouled off." is pitch F, pitchType cutter.
  "A cut fastball in on the hands, ball." is pitch B, pitchType cutter.
  "A bender, misses low." is pitch B, pitchType curveball.
  "Bender, called strike." is pitch C, pitchType curveball.
  "Yakker, swinging strike." is pitch S, pitchType curveball.
  "A yakker in the dirt, ball." is pitch B, pitchType curveball.
  "Spike curve, called strike." is pitch C, pitchType knuckle_curve.
  "A spike curve in the dirt, ball." is pitch B, pitchType knuckle_curve.
  "Circle change, swing and a miss." is pitch S, pitchType changeup.
  "Circle change, low, ball." is pitch B, pitchType changeup.
  "Change of pace, called strike." is pitch C, pitchType changeup.
  "A change of pace, fouled off." is pitch F, pitchType changeup.
  "Splitty in the dirt, swinging strike." is pitch S, pitchType splitter.
  "Splitty, ball low." is pitch B, pitchType splitter.
  "Blooper pitch, taken for a ball." is pitch B, pitchType eephus.
  "A blooper pitch, swinging strike." is pitch S, pitchType eephus.
  "Junk away, ball." is pitch B with no pitchType.
  "More junk, swinging strike." is pitch S with no pitchType.
  "Something soft, called strike." is pitch C with no pitchType.
  "Something soft away, ball." is pitch B with no pitchType.
  "Breaking ball, swinging strike." is pitch S with no pitchType.
  "A breaking ball outside, ball." is pitch B, no pitchType, pitchLocation
  middle, away, inZone false.`

/** Both, as the unit test reads them. */
export const PLACE_INSTRUCTIONS = `${PITCH_INSTRUCTIONS}\n\n${BALL_PLACE_INSTRUCTIONS}`

/**
 * The words the section works, each at least twice. The unit test counts
 * the worked lines each appears in.
 */
export const PLACE_KEYWORDS: readonly string[] = [
  'dribbler',
  'nubber',
  'swinging bunt',
  'squibber',
  'tapper',
  'one-hopper',
  'high chopper',
  'in the hole',
  'infield pop',
  'shy of',
  'short of third',
  'past first',
  'past third',
  'bloop',
  'blooper',
  'texas leaguer',
  'flare',
  'dying quail',
  'duck snort',
  "no-man's land",
  'shallow',
  'short center',
  'seeing-eye',
  'in front of the outfielder',
  'can of corn',
  'routine fly',
  'lazy fly',
  'deep',
  'over his head',
  'in the gap',
  'into the gap',
  'into the corner',
  'warning track',
  'to the track',
  'on the track',
  'back to the wall',
  'off the wall',
  'off the fence',
  'hits the wall',
  'feet',
  'foul',
  'misses',
  'in the zone',
  'down the middle',
  'inside',
  'outside',
  'away',
  'high',
  'low',
  'at the knees',
  'painted',
  'fastball',
  'heater',
  'four-seamer',
  'two-seamer',
  'sinker',
  'cutter',
  'slider',
  'sweeper',
  'slurve',
  'curveball',
  'curve',
  'hook',
  'uncle charlie',
  'twelve-to-six',
  'knuckle curve',
  'slow curve',
  'changeup',
  'change',
  'off-speed',
  'splitter',
  'split-finger',
  'forkball',
  'screwball',
  'knuckleball',
  'knuckler',
  'eephus',
  'breaking ball',
  'gas',
  'cheese',
  'number one',
  'riser',
  'sinking fastball',
  'cut fastball',
  'bender',
  'yakker',
  'spike curve',
  'circle change',
  'change of pace',
  'splitty',
  'blooper pitch',
  'junk',
  'something soft'
]

/** Words that say where a ball in play or a foul went. */
const BALL_WORDS: readonly string[] = [
  ...Object.values(DEPTH_WORDS).flat(),
  'shy of',
  'short of',
  'foul',
  'feet',
  'foot',
  'wall',
  'fence',
  'track',
  'gap',
  'corner',
  'seats'
]
/**
 * Words that say where a pitch crossed the plate, or what kind it was: a
 * pitch's name, a location phrase, or a location word beside a pitch's call.
 * A ball up the middle, a high fly or a throw that gets away is none.
 */
const PITCH_PHRASE =
  /\b(?:high|low|up|down) and (?:in|inside|away|outside|tight)\b|\b(?:inside|outside) corner\b|\bon the corner\b|\bpainted\b|\bin the dirt\b|\bat the knees\b|\bon the hands\b|\bgrooved\b|\b(?:in|out of) the zone\b|\bmiss(?:es|ed)? (?:high|low|inside|outside|away|in|up|down)\b|\bbreaking ball\b|\bjunk\b|\bsomething soft\b/i
/** A location word within a few words of a ball or strike call. */
const LOCATION_BESIDE_CALL =
  /\b(?:high|low|inside|outside|away|tight|middle)\b[^.]{0,25}?(?:\bstrike\b|\bball (?:one|two|three|four)\b|,\s*ball\b)|(?:\bstrike\b|\bball (?:one|two|three|four)\b)[^.]{0,25}?\b(?:high|low|inside|outside|away|tight|middle)\b/i
function pitchSaid(transcript: string): boolean {
  return (
    namesPitchType(transcript) ||
    PITCH_PHRASE.test(transcript) ||
    LOCATION_BESIDE_CALL.test(transcript)
  )
}
const said = (words: readonly string[]): RegExp =>
  new RegExp(
    `\\b(?:${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'i'
  )
const BALL_SAID = said(BALL_WORDS)

/**
 * The sections a sentence's words call for, each after a blank line, for its
 * game message: only a sentence that says where a ball or a pitch went is
 * taught how to read it, and the rest are scored as they always were.
 */
export function placeSections(transcript: string): string {
  const called = placesCalled(transcript)
  return [
    ...(called.pitch ? [PITCH_INSTRUCTIONS] : []),
    ...(called.ball ? [BALL_PLACE_INSTRUCTIONS] : [])
  ]
    .map(section => `\n\n${section}`)
    .join('')
}

/** Which sections a sentence's words call for. */
export function placesCalled(transcript: string): {
  pitch: boolean
  ball: boolean
} {
  return { pitch: pitchSaid(transcript), ball: BALL_SAID.test(transcript) }
}

/**
 * The tools as a sentence is offered them: the fields of where a ball and a
 * pitch went only beside the section that teaches them. Offered to every
 * sentence, they drew the model into placing balls and naming fielders the
 * words never gave.
 */
export function placeTools(tools: readonly Tool[], transcript: string): Tool[] {
  const called = placesCalled(transcript)
  const hidden = new Set<string>([
    ...(called.ball
      ? []
      : [
          'pitch.direction',
          'pitch.depth',
          'ballInPlay.depth',
          'ballInPlay.distanceFeet'
        ]),
    ...(called.pitch ? [] : ['pitch.pitchType', 'ballInPlay.pitchType'])
  ])
  return tools.map(tool => {
    const properties = tool.input_schema.properties ?? {}
    if (!Object.keys(properties).some(key => hidden.has(`${tool.name}.${key}`)))
      return tool
    return {
      ...tool,
      input_schema: {
        ...tool.input_schema,
        properties: Object.fromEntries(
          Object.entries(properties).filter(
            ([key]) => !hidden.has(`${tool.name}.${key}`)
          )
        )
      }
    }
  })
}
