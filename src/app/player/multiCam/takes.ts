/**
 * Which of a game's videos are angles of one take, and what to call them.
 *
 * Two facts about the library decide everything here, and both were measured
 * rather than assumed:
 *
 * - **The Distributor joins a camera's name to the title with a plain space.**
 *   `PeerTubeTitle.make` is `"<base> <camera>"`; there is no em dash. The em
 *   dash belongs to the live path, which writes `"<title> — <camera>"`. So
 *   `angleName`'s split names live cameras and has never named an uploaded
 *   one — today those show as `Video 1 … Video 4`, which is the numbering
 *   branch admitting it does not know.
 * - **The mosaic shares that base and agrees on length by construction**, so
 *   neither the title nor the duration can be used to keep it out of a grid of
 *   camera angles. It is excluded by name and by `numCameras`, both, because
 *   `numCameras` is a title test in a column's clothes: the sweep that sets it
 *   only ever looks at titles ending `raw` or `combined`, and a fresh upload
 *   reads as one camera until somebody runs it by hand.
 */

export interface AngleCandidate {
  id: string
  title: string
  status: string
  numCameras: number
  durationSec: number | null
  /** When its first frame was filmed, which is what puts it on the game's clock. */
  startAt?: string | null
}

/** Four angles at once, as the Distributor's own layout caps it. */
export const MAX_ANGLES = 4

/** How far two takes' lengths may differ and still be one take. */
const LENGTH_TOLERANCE_SEC = 90

/** What a mosaic's own suffix looks like, in either generation's spelling. */
const MOSAIC_SUFFIX = /^(raw|combined)$/i

/**
 * The words two titles begin with, as words rather than as characters.
 *
 * At a token boundary on purpose. Character-wise, `1st` and `1st base` share
 * `1st`, and `Badgers vs Blueberries` and `Badgers vs Blueberr` share all but
 * three letters — a prefix that ends in the middle of a word is a coincidence,
 * not a shared title.
 */
export function sharedPrefix(a: string, b: string): string {
  const left = a.trim().split(/\s+/)
  const right = b.trim().split(/\s+/)
  const words: string[] = []
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) break
    words.push(left[index])
  }
  return words.join(' ')
}

/** What is left of a title once the take's shared part is taken off. */
export function suffixAfter(title: string, prefix: string): string {
  const trimmed = title.trim()
  if (prefix === '' || !trimmed.startsWith(prefix)) return ''
  return trimmed.slice(prefix.length).trim()
}

/**
 * Is this video the mosaic rather than one of the cameras in it?
 *
 * Belt and braces, for the reason at the top of this file: either signal on
 * its own misses a case the other catches.
 */
export function isMosaic(video: AngleCandidate, suffix: string): boolean {
  if (video.numCameras > 1) return true
  if (MOSAIC_SUFFIX.test(suffix)) return true
  // The last word of the title, for a mosaic that has no siblings to be
  // compared against — an upload whose cameras were never sent, or a legacy
  // import sitting on its own. Its suffix is empty because there is nothing to
  // take a prefix from, and without this it reads as an ordinary camera and
  // gets ticked into the grid.
  const last = video.title.trim().split(/\s+/).pop() ?? ''
  return MOSAIC_SUFFIX.test(last)
}

/**
 * The videos of one game, grouped into takes.
 *
 * Pairwise: a video joins a group when it shares a whole-word prefix with
 * something already in it and its length agrees. Not a single longest common
 * prefix across everything — legacy imports sit beside new uploads and their
 * titles have nothing in common but the date, so one prefix over the lot
 * collapses every video of the game into a single group and says nothing.
 *
 * This is a guess with a good hit rate, not an authority, which is why the
 * picker lets somebody tick four videos it did not group.
 */
export function groupIntoTakes(videos: AngleCandidate[]): AngleCandidate[][] {
  const groups: AngleCandidate[][] = []
  for (const video of videos) {
    const joined = groups.find(group =>
      group.some(member => {
        const prefix = sharedPrefix(member.title, video.title)
        if (prefix === '' || prefix.split(/\s+/).length < 2) return false
        const a = member.durationSec
        const b = video.durationSec
        if (a == null || b == null) return true
        return Math.abs(a - b) <= LENGTH_TOLERANCE_SEC
      })
    )
    if (joined == null) groups.push([video])
    else joined.push(video)
  }
  return groups
}

export interface AngleLabel {
  id: string
  /** What to call it on the picker and on its tile. */
  name: string
  /** True where this is the mosaic, which is never ticked by default. */
  mosaic: boolean
}

/**
 * Names for a game's videos, recovered from what they share.
 *
 * The camera's name is whatever is left when the take's shared words are taken
 * off — `2026-09-13 Badgers vs Cedar Lakes 3rd` against its siblings gives
 * `3rd`. The track with nothing left is the primary output, because
 * `.primary` is the one upload that carries no suffix at all.
 *
 * A live video keeps the name after its em dash, which already works and is
 * left alone. A video with no siblings to compare against keeps its own title,
 * minus the date, because a lone video's name is all there is.
 */
export function angleLabels(videos: AngleCandidate[]): AngleLabel[] {
  const groups = groupIntoTakes(videos)
  const out = new Map<string, AngleLabel>()

  for (const group of groups) {
    for (const video of group) {
      const dashed = video.title.split(' — ')
      if (dashed.length > 1 && dashed[dashed.length - 1].trim() !== '') {
        const name = dashed[dashed.length - 1].trim()
        out.set(video.id, {
          id: video.id,
          name,
          mosaic: isMosaic(video, name)
        })
        continue
      }

      // The longest prefix this video shares with any of its siblings. Longest,
      // because a group can hold a mosaic whose base is a word shorter than the
      // cameras' when the title was typed differently on two upload sessions.
      let prefix = ''
      for (const other of group) {
        if (other.id === video.id) continue
        const shared = sharedPrefix(video.title, other.title)
        if (shared.length > prefix.length) prefix = shared
      }
      const suffix = suffixAfter(video.title, prefix)
      const name =
        suffix !== ''
          ? suffix
          : group.length > 1
            ? 'Primary'
            : withoutDate(video.title)
      out.set(video.id, { id: video.id, name, mosaic: isMosaic(video, suffix) })
    }
  }

  // Two cameras that end up with the same word are numbered, because two
  // buttons with one name is a choice nobody can make.
  const counts = new Map<string, number>()
  for (const label of out.values()) {
    counts.set(label.name, (counts.get(label.name) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return videos.map(video => {
    const label = out.get(video.id)!
    if ((counts.get(label.name) ?? 0) < 2) return label
    const nth = (seen.get(label.name) ?? 0) + 1
    seen.set(label.name, nth)
    return { ...label, name: `${label.name} ${nth}` }
  })
}

/**
 * Which tile is heard, when nobody has chosen one.
 *
 * The longest of the chosen angles. Two reasons, and they agree: a camera's
 * archive carries no sound at all — the exporter writes it a silent track, so
 * every take's sound is its programme output — and the longest angle is the
 * one most likely to be playing at any given moment.
 *
 * It used to be whichever angle sorted first, which is fine while the grid
 * holds one take and wrong the moment it does not. A game holding a two-hour
 * recording and a 107-second clip put the sound on the clip: a tile the view
 * correctly refuses to start, muting every other tile to do it, so the game
 * played in silence with the speaker sitting on a picture that never moved.
 */
export function soundAngle(
  videos: AngleCandidate[],
  order: string[],
  heard?: string | null,
  /**
   * Where the viewer is, as a wall clock. Left out, the grid's own beginning
   * is used — the earliest angle on it.
   */
  atMs?: number | null
): string | null {
  // The tiles that are actually drawn, which is the only set a sound can
  // come out of: ticked, still in the game, and inside the four the grid
  // holds. Checking the tick list alone was not enough — an address outlives
  // the videos it names, and a link kept from before an angle was deleted or
  // hidden went on naming it, so the grid muted every tile that was playing
  // in favour of one that was not there at all.
  const drawn = order
    .slice(0, MAX_ANGLES)
    .map(id => videos.find(one => one.id === id))
    .filter((one): one is AngleCandidate => one != null)

  // What was already being heard, but only while it is still one of those.
  // Every caller had written `heard ?? soundAngle(…)` instead, which keeps a
  // tile that has since been unticked: the grid then mutes everything else to
  // favour a tile that is not there, and the game plays in silence. Deciding
  // it here is the only way it stops being decided wrongly somewhere else.
  if (heard != null && drawn.some(one => one.id === heard)) return heard

  if (drawn.length === 0) return null

  // Of those, the ones that have a picture where the viewer actually is.
  // A tick list can span two takes — the picker fills leftover quadrants from
  // other takes on purpose — and then the longest angle, which is what this
  // falls back to, can easily be one that has not started yet or has long
  // finished. It held the sound anyway, so its tile read "Not recording yet"
  // or sat paused on its own last frame while every tile that *was* playing
  // was muted against it, and the game played in silence.
  //
  // Which is why this takes the position rather than the grid's beginning.
  // Asked once, at the open, it answers for one instant of a timeline that
  // can be days long: the view asks again as the position moves.
  const at =
    atMs ??
    Math.min(
      ...drawn
        .map(one => startedAt(one))
        .filter((one): one is number => one != null)
    )
  const playing = Number.isFinite(at)
    ? drawn.filter(one => playsAt(one, at))
    : []
  // Nothing dated, or nothing playing there: the longest of everything, which
  // is the answer this had before and is still better than none.
  const pool = playing.length > 0 ? playing : drawn

  return pool.reduce((best, one) => (better(one, best, pool) ? one : best)).id
}

/**
 * Which of two angles should be heard, where both could be.
 *
 * Longest first, for the reason the whole rule exists: a take's sound is its
 * programme output, and the programme output is the angle that spans the
 * take. The rest of this is about **ties**, which are not rare — a take's
 * angles are recorded together and stored to the second, so 35 of the seat's
 * 43 games have two angles of exactly equal length.
 *
 * A tie used to be broken by position in the tick list, which is the grid's
 * layout: **one drag moved the sound**, and it moved it from a programme
 * output to a camera archive, which is silent by design. So the programme
 * comes first — the one upload whose title carries no camera suffix — and
 * after that the id, which is stable and belongs to the recording rather than
 * to where somebody dropped its tile.
 */
function better(
  one: AngleCandidate,
  best: AngleCandidate,
  pool: AngleCandidate[]
): boolean {
  const length = one.durationSec ?? 0
  const bestLength = best.durationSec ?? 0
  if (length !== bestLength) return length > bestLength

  const named = isPrimary(one, pool)
  if (named !== isPrimary(best, pool)) return named

  return one.id < best.id
}

/**
 * Is this the take's programme output?
 *
 * The one upload that carries no camera suffix, which is how the library has
 * told the angles apart since the Distributor started sending them.
 */
function isPrimary(one: AngleCandidate, pool: AngleCandidate[]): boolean {
  const prefix = pool
    .map(other => other.title)
    .reduce((shared, title) => sharedPrefix(shared, title))
  return suffixAfter(one.title, prefix) === ''
}

/** An angle's start as a number, or nothing where it has none to give. */
function startedAt(one: AngleCandidate): number | null {
  if (one.startAt == null) return null
  const at = Date.parse(one.startAt)
  return Number.isFinite(at) ? at : null
}

/**
 * How far after an instant an angle may start and still count as being there
 * for it.
 *
 * The angles of one take start within a second of each other — one operator
 * action starts them all, and this branch exists to hold them inside a tenth
 * of a second of each other. A different take is minutes away at the nearest.
 * Five seconds sits an order of magnitude above the first and two orders
 * below the second, so it separates them without having to know which take
 * anything belongs to.
 */
const SAME_MOMENT_SEC = 5

/**
 * Whether this angle has a picture at that instant.
 *
 * An angle with no length is taken as still running: a live recording that
 * has not been measured yet is playing, not finished.
 */
function playsAt(one: AngleCandidate, at: number): boolean {
  const from = startedAt(one)
  if (from == null || at < from - SAME_MOMENT_SEC * 1000) return false
  if (one.durationSec == null) return true
  return at < from + one.durationSec * 1000
}

/** A title with its `YYYY-MM-DD ` prefix taken off, which names nothing. */
function withoutDate(title: string): string {
  return title.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').trim()
}

/**
 * The four ticked when the picker opens.
 *
 * **The angles of one take**, in the order the server sent them — which is
 * `coalesce(start_at, created_at)`, then Primary, 1st, 3rd and Home, then
 * `id`. The biggest group wins, and a take's own cameras fill the grid
 * before anything outside it.
 *
 * Taking the first four of everything instead put a whole second recording of
 * the same game into a quadrant and pushed a real camera out: a game that
 * keeps its live stream beside a four-camera upload has five playable videos,
 * and the stream sorts first. The stream is not an angle — it is another copy
 * of the game — and the same argument excludes the mosaic, which is why that
 * was already excluded.
 */
export function defaultAngles(videos: AngleCandidate[]): string[] {
  const labels = new Map(angleLabels(videos).map(one => [one.id, one]))
  const playable = videos.filter(
    video =>
      (video.status === 'ready' || video.status === 'live') &&
      // A recording of no length is a quadrant that can only ever say it was
      // not recording yet, and then that it has stopped.
      video.durationSec !== 0
  )
  const cameras = playable.filter(
    video => labels.get(video.id)?.mosaic !== true
  )
  const chosen = cameras.length > 0 ? cameras : playable

  // The largest take among them, ties going to the one that starts earliest —
  // `chosen` is already in the server's order, so the first group wins a tie.
  const groups = groupIntoTakes(chosen)
  const take = groups.reduce(
    (best, group) => (group.length > best.length ? group : best),
    groups[0] ?? []
  )
  const inTake = new Set(take.map(video => video.id))

  // The take first, then anything else the game holds, so a game whose videos
  // group into ones and twos still fills its quadrants.
  const ordered = [
    ...chosen.filter(video => inTake.has(video.id)),
    ...chosen.filter(video => !inTake.has(video.id))
  ]
  return ordered.slice(0, MAX_ANGLES).map(video => video.id)
}
