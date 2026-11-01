import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Where a recording's sound begins, against the picture it arrives with.
 *
 * Every recording this server writes is fragmented MP4, and every fragment
 * says where on the stream's clock its samples begin (`tfdt`). A sound track
 * that starts late — the sound camera was not delivering when the stream went
 * live — first appears in some fragment part way through, alongside the
 * picture of that moment. If its stamp says something else, the sound will
 * play at the wrong time for the whole of the recording: the Lizard live copy
 * carried sound that first arrived with the picture at 1,110 s, stamped 0 s,
 * and every player stalled or played it 18 minutes out of step.
 *
 * So the check is local and needs no knowledge of how the stream was made:
 * find the first fragment carrying sound, find the picture fragment it arrived
 * in, and see whether the sound's stamp falls inside that picture's span.
 * Correct stamps put it there by construction; a track stamped from its own
 * first packet puts it wherever its own count says.
 *
 * Only the `moov` and the `moof` headers are read. A recording is gigabytes of
 * `mdat`, and none of it is needed to answer this.
 */

/** How far outside its picture a sound stamp may fall before it is wrong. */
export const SOUND_STEP_TOLERANCE_SEC = 1

export interface TrackInfo {
  kind: 'video' | 'audio' | 'other'
  timescale: number
  /** The `trex` default, for fragments that name no duration of their own. */
  defaultSampleDuration: number
}

/** One track's samples in one fragment, on the stream's clock. */
export interface FragmentRun {
  trackId: number
  kind: TrackInfo['kind']
  startSec: number
  durationSec: number
}

export interface SoundPlacement {
  /** Where the sound's first fragment is stamped. */
  soundStartSec: number
  /** The picture fragment the sound first arrived with. */
  pictureStartSec: number
  pictureEndSec: number
  /**
   * How far the sound's stamp falls outside that picture's span: negative
   * before it, positive after it, 0 inside it.
   */
  offsetSec: number
}

/** The tracks of an init segment (or of the `moov` of a whole file). */
export function readTracks(moov: Buffer): Map<number, TrackInfo> {
  const tracks = new Map<number, TrackInfo>()
  const defaults = new Map<number, number>()
  for (const box of boxesIn(moov)) {
    if (box.type === 'mvex') {
      for (const trex of boxesIn(box.payload)) {
        if (trex.type !== 'trex' || trex.payload.length < 16) continue
        defaults.set(
          trex.payload.readUInt32BE(4),
          trex.payload.readUInt32BE(12)
        )
      }
    }
    if (box.type !== 'trak') continue
    const tkhd = childBox(box.payload, 'tkhd')
    const mdia = childBox(box.payload, 'mdia')
    if (tkhd == null || mdia == null) continue
    const mdhd = childBox(mdia, 'mdhd')
    const hdlr = childBox(mdia, 'hdlr')
    if (mdhd == null || hdlr == null || hdlr.length < 12) continue
    const id = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12)
    const timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12)
    const handler = hdlr.toString('latin1', 8, 12)
    tracks.set(id, {
      kind:
        handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other',
      timescale,
      defaultSampleDuration: 0
    })
  }
  for (const [id, duration] of defaults) {
    const track = tracks.get(id)
    if (track != null) track.defaultSampleDuration = duration
  }
  return tracks
}

/** Each track's run in one `moof`, in seconds on the stream's clock. */
export function readFragment(
  moof: Buffer,
  tracks: Map<number, TrackInfo>
): FragmentRun[] {
  const runs: FragmentRun[] = []
  for (const traf of boxesIn(moof)) {
    if (traf.type !== 'traf') continue
    const tfhd = childBox(traf.payload, 'tfhd')
    const tfdt = childBox(traf.payload, 'tfdt')
    if (tfhd == null || tfdt == null) continue
    const trackId = tfhd.readUInt32BE(4)
    const track = tracks.get(trackId)
    if (track == null || track.timescale === 0) continue

    const tfhdFlags = tfhd.readUInt32BE(0) & 0xffffff
    let at = 8
    if ((tfhdFlags & 0x1) !== 0) at += 8
    if ((tfhdFlags & 0x2) !== 0) at += 4
    const defaultDuration =
      (tfhdFlags & 0x8) !== 0
        ? tfhd.readUInt32BE(at)
        : track.defaultSampleDuration

    const start =
      tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4)

    let duration = 0
    for (const trun of boxesIn(traf.payload)) {
      if (trun.type === 'trun')
        duration += runDuration(trun.payload, defaultDuration)
    }
    runs.push({
      trackId,
      kind: track.kind,
      startSec: start / track.timescale,
      durationSec: duration / track.timescale
    })
  }
  return runs
}

/** The sum of a `trun`'s sample durations. */
function runDuration(trun: Buffer, defaultDuration: number): number {
  const flags = trun.readUInt32BE(0) & 0xffffff
  const count = trun.readUInt32BE(4)
  let at = 8
  if ((flags & 0x1) !== 0) at += 4
  if ((flags & 0x4) !== 0) at += 4
  if ((flags & 0x100) === 0) return count * defaultDuration
  const stride =
    4 +
    ((flags & 0x200) !== 0 ? 4 : 0) +
    ((flags & 0x400) !== 0 ? 4 : 0) +
    ((flags & 0x800) !== 0 ? 4 : 0)
  let total = 0
  for (let i = 0; i < count && at + 4 <= trun.length; i++, at += stride) {
    total += trun.readUInt32BE(at)
  }
  return total
}

/**
 * Where the sound starts against the picture it first arrives with, or
 * nothing when there is no sound, or no picture to measure it against.
 *
 * Fragments are taken in order and the walk stops at the answer, so a caller
 * reading them lazily reads only as far as the sound's first appearance.
 */
export async function placeSound(
  tracks: Map<number, TrackInfo>,
  moofs: AsyncIterable<Buffer> | Iterable<Buffer>
): Promise<SoundPlacement | undefined> {
  let picture: FragmentRun | undefined
  let sound: FragmentRun | undefined
  // Whether picture had already been going before the sound turned up. Only
  // then is a stamp earlier than its picture wrong: sound at the very start of
  // a stream may begin before the first picture, and often does.
  let joinedPicture = false
  for await (const moof of moofs) {
    const runs = readFragment(moof, tracks)
    const here = runs.find(run => run.kind === 'video')
    if (sound == null) {
      sound = runs.find(run => run.kind === 'audio')
      joinedPicture = sound != null && picture != null
    }
    if (here != null) picture = here
    if (sound != null && picture != null) {
      return measure(sound, picture, joinedPicture)
    }
  }
  return undefined
}

function measure(
  sound: FragmentRun,
  picture: FragmentRun,
  joinedPicture: boolean
): SoundPlacement {
  const pictureStartSec = picture.startSec
  const pictureEndSec = picture.startSec + picture.durationSec
  const offsetSec =
    sound.startSec > pictureEndSec
      ? sound.startSec - pictureEndSec
      : sound.startSec < pictureStartSec && joinedPicture
        ? sound.startSec - pictureStartSec
        : 0
  return {
    soundStartSec: sound.startSec,
    pictureStartSec,
    pictureEndSec,
    offsetSec
  }
}

const SOUND_STEP_PREFIX = 'sound is stamped '

/** Whether a row's message is one `soundStepProblem` wrote. */
export function isSoundStepProblem(
  message: string | null | undefined
): boolean {
  return message?.startsWith(SOUND_STEP_PREFIX) === true
}

/** What to say about a placement, or nothing when the sound is where it belongs. */
export function soundStepProblem(
  placement: SoundPlacement | undefined
): string | undefined {
  if (placement == null) return undefined
  if (Math.abs(placement.offsetSec) <= SOUND_STEP_TOLERANCE_SEC)
    return undefined
  const seconds = Math.abs(placement.offsetSec).toFixed(1)
  const way = placement.offsetSec < 0 ? 'ahead of' : 'behind'
  return (
    `${SOUND_STEP_PREFIX}${seconds} s ${way} the picture it arrives with ` +
    `(sound ${placement.soundStartSec.toFixed(3)} s, picture ` +
    `${placement.pictureStartSec.toFixed(3)}–${placement.pictureEndSec.toFixed(3)} s)`
  )
}

/**
 * Checks a finished HLS playlist of fMP4: its init segment, then its segments
 * in playlist order, reading only the `moof` headers. A live stream's
 * playlist of segments and a recording's single-file playlist read the same.
 */
export async function checkTrackStarts(
  playlistPath: string
): Promise<SoundPlacement | undefined> {
  const playlist = await readFile(playlistPath, 'utf8')
  const dir = dirname(playlistPath)
  const map = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(playlist)?.[1]
  if (map == null) return undefined
  // The tracks are that init segment's, so only the segments under it can be
  // read by them: a later map's may number its tracks another way.
  const [firstRun] = /#EXT-X-MAP:[^]*?(?=#EXT-X-MAP:|$)/.exec(playlist) ?? ['']
  const moov = await firstBox(join(dir, map), 'moov')
  if (moov == null) return undefined
  const tracks = readTracks(moov)
  // A single-file recording names the same file once per byte range; it is
  // read once, start to finish.
  const segments = [
    ...new Set(
      firstRun
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
    )
  ]
  return await placeSound(
    tracks,
    moofsOf(segments.map(name => join(dir, name)))
  )
}

async function* moofsOf(paths: string[]): AsyncGenerator<Buffer> {
  for (const path of paths) {
    yield* boxesInFile(path, 'moof')
  }
}

async function firstBox(
  path: string,
  type: string
): Promise<Buffer | undefined> {
  const boxes = boxesInFile(path, type)
  const first = await boxes.next()
  await boxes.return(undefined)
  return first.done === true ? undefined : first.value
}

/**
 * How long a segment's picture really lasts, in seconds: the durations of its
 * video samples added up, read from its `moof` headers with the timescale its
 * init segment gives. Null when either cannot be read or there is no picture.
 *
 * Not what the playlist says. FFmpeg lists the last segment a writer closes
 * as running to its last picture's *start*, a frame short of its end, and a
 * writer appending after it then starts that frame too early.
 */
export function segmentPictureSec(
  init: Buffer,
  segment: Buffer
): number | null {
  const moov = childBox(init, 'moov')
  if (moov == null) return null
  const tracks = readTracks(moov)
  let total = 0
  let found = false
  for (const box of boxesIn(segment)) {
    if (box.type !== 'moof') continue
    for (const run of readFragment(box.payload, tracks)) {
      if (run.kind !== 'video') continue
      total += run.durationSec
      found = true
    }
  }
  return found ? total : null
}

/**
 * The payload of every top-level box of one type in a file, read one at a
 * time and skipping everything else unread.
 */
export async function* boxesInFile(
  path: string,
  type: string
): AsyncGenerator<Buffer> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (handle == null) return
  try {
    const { size: fileSize } = await handle.stat()
    const header = Buffer.alloc(16)
    let at = 0
    while (at + 8 <= fileSize) {
      const { bytesRead } = await handle.read(header, 0, 16, at)
      if (bytesRead < 8) return
      let size = header.readUInt32BE(0)
      const boxType = header.toString('latin1', 4, 8)
      let headerSize = 8
      if (size === 1) {
        if (bytesRead < 16) return
        size = Number(header.readBigUInt64BE(8))
        headerSize = 16
      } else if (size === 0) {
        size = fileSize - at
      }
      if (size < headerSize || at + size > fileSize) return
      if (boxType === type) {
        const payload = Buffer.alloc(size - headerSize)
        await handle.read(payload, 0, payload.length, at + headerSize)
        yield payload
      }
      at += size
    }
  } finally {
    await handle.close()
  }
}

interface Box {
  type: string
  payload: Buffer
}

/** Every box at this level, ignoring anything truncated. */
function* boxesIn(buffer: Buffer): Generator<Box> {
  let at = 0
  while (at + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const end = size === 0 ? buffer.length : at + size
    if (size < 8 || end > buffer.length) return
    yield { type, payload: buffer.subarray(at + 8, end) }
    at = end
  }
}

function childBox(buffer: Buffer, type: string): Buffer | undefined {
  for (const box of boxesIn(buffer)) {
    if (box.type === type) return box.payload
  }
  return undefined
}
