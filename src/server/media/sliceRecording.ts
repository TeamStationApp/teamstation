import { INIT_FILE, initFileName, segmentFileName } from './ffmpeg'
import { putObject, SpaceRefusal } from './images'
import { presignGetUrl } from './presign'
import type { SpaceSettings } from './spacesHls'
import { spaceKey } from './spacesHls'
import {
  contentTypeFor,
  eachInFlight,
  OBJECTS_IN_FLIGHT,
  withSpaceRetry
} from './spacesVideo'
import { uploadHeadersFor, withoutSecrets } from './videoPrefix'

/**
 * Repackaging a recording that is one `video.mp4` into segment objects,
 * without FFmpeg and without this machine's disk.
 *
 * A single-file recording's media playlist already says where every fragment
 * is: each `EXT-X-BYTERANGE` is one complete fragment (`moof` + `mdat`), and
 * each `EXT-X-MAP` range one init segment. Copying each range to an object of
 * its own, and listing those objects instead of the ranges, gives the same
 * bytes on the same timeline as a segmented recording: the names the live
 * origin and the segmented remux use, so everything downstream reads it.
 *
 * Only the recordings already in the Space in that shape are sliced. Anything
 * new is remuxed straight into segments.
 */

/** One object to make: this range of the single file, under this name. */
export interface SlicePiece {
  name: string
  kind: 'init' | 'segment'
  offset: number
  length: number
}

export interface SlicePlan {
  /** The one media file every range is of: `video.mp4`. */
  media: string
  /** Every init and segment, in the order the file holds them. */
  pieces: SlicePiece[]
  /** The media playlist that lists the pieces: no byte ranges. */
  playlist: string
  /** How long the media file is, by its ranges. */
  bytes: number
}

/**
 * The pieces of a single-file media playlist and the playlist that lists
 * them. The first `EXT-X-MAP` is `init.mp4`; a later, different one is
 * `init<NNNNNN>.mp4`, after the first segment that uses it; a repeated
 * identical one is the same piece. Every other tag stays where it was.
 *
 * Throws on a playlist that is not one file in ranges: no byte ranges, more
 * than one media file, or ranges that overlap or leave a gap.
 */
export function slicePlan(playlist: string): SlicePlan {
  const pieces: SlicePiece[] = []
  const inits = new Map<string, string>()
  const out: string[] = []
  let media: string | undefined
  let pendingMap: { offset: number; length: number } | undefined
  let range: { offset: number; length: number } | undefined
  let nextOffset = 0
  let segments = 0
  let ranged = false

  const sameFile = (uri: string): void => {
    if (media == null) media = uri
    else if (media !== uri)
      throw new Error(`more than one media file: ${media} and ${uri}`)
  }

  for (const line of playlist.split('\n')) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1]
      const found = /BYTERANGE="(\d+)@(\d+)"/.exec(line)
      if (uri == null || found == null)
        throw new Error(`a map with no byte range: ${line}`)
      sameFile(uri)
      ranged = true
      pendingMap = { length: Number(found[1]), offset: Number(found[2]) }
      nextOffset = pendingMap.offset + pendingMap.length
      // Named once its first segment is known; held in the output for now.
      out.push(line)
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [length, offset] = line.slice('#EXT-X-BYTERANGE:'.length).split('@')
      range = {
        length: Number(length),
        offset: offset == null ? nextOffset : Number(offset)
      }
      nextOffset = range.offset + range.length
      ranged = true
      continue
    }
    if (line === '' || line.startsWith('#')) {
      out.push(line)
      continue
    }
    // A media URI, which ends the entry the tags above described.
    sameFile(line)
    if (range == null) throw new Error(`a segment with no byte range: ${line}`)
    if (pendingMap != null) {
      const key = `${pendingMap.offset}@${pendingMap.length}`
      let name = inits.get(key)
      if (name == null) {
        name = inits.size === 0 ? INIT_FILE : initFileName(segments)
        inits.set(key, name)
        pieces.push({ name, kind: 'init', ...pendingMap })
      }
      const at = out.map(one => one.startsWith('#EXT-X-MAP:')).lastIndexOf(true)
      out[at] = `#EXT-X-MAP:URI="${name}"`
      pendingMap = undefined
    }
    const name = segmentFileName(segments++)
    pieces.push({ name, kind: 'segment', ...range })
    out.push(name)
    range = undefined
  }
  if (!ranged || media == null || segments === 0)
    throw new Error('not a single-file playlist: it has no byte ranges')

  const ordered = [...pieces].sort((a, b) => a.offset - b.offset)
  let end = 0
  for (const piece of ordered) {
    if (piece.offset < end)
      throw new Error(`${piece.name} overlaps the range before it`)
    if (piece.offset > end)
      throw new Error(
        `a gap of ${piece.offset - end} bytes before ${piece.name}`
      )
    end = piece.offset + piece.length
  }
  return {
    media,
    pieces: ordered,
    playlist: out.join('\n'),
    bytes: end
  }
}

/** How long one piece's GET or PUT may take before it is tried again. */
export const PIECE_TIMEOUT_MS = 120_000

/** The boxes a piece of each kind may start with. */
const LEADING: Record<SlicePiece['kind'], string[]> = {
  init: ['ftyp'],
  segment: ['moof', 'styp', 'sidx']
}

/** The type of each top-level box in `bytes`. */
function boxTypes(bytes: Uint8Array): string[] {
  const types: string[] = []
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at + 8 <= view.length;) {
    const size = view.readUInt32BE(at)
    types.push(view.toString('latin1', at + 4, at + 8))
    if (size < 8) break
    at += size
  }
  return types
}

/** Whether a piece holds what its kind says: an init, or a fragment. */
export function pieceLooksRight(piece: SlicePiece, bytes: Uint8Array): boolean {
  const types = boxTypes(bytes)
  if (!LEADING[piece.kind].includes(types[0] ?? '')) return false
  return piece.kind === 'init' ? types.includes('moov') : types.includes('moof')
}

export interface SliceOptions {
  space: SpaceSettings
  /** The single file, under its current prefix. */
  source: { id: string; spaceSecret: string | null }
  /** Where the pieces go. */
  target: { id: string; spaceSecret: string }
  plan: SlicePlan
  /** The single file's length in the Space, which the pieces must cover. */
  objectBytes: number
  fetch?: typeof fetch
  put?: typeof putObject
}

/**
 * Copies every piece of a single file to an object of its own: a ranged GET
 * from the presigned origin URL (never the CDN, where a range deep inside a
 * big file is the stall this exists to end), then a PUT with the headers its
 * kind takes. `OBJECTS_IN_FLIGHT` at once, each piece in memory only while it
 * is copied; a `503 Slow Down` is retried as an upload's is.
 */
export async function sliceSpaceObject(options: SliceOptions): Promise<void> {
  const { space, source, target, plan } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const put = options.put ?? putObject
  if (plan.bytes !== options.objectBytes) {
    throw new Error(
      `the ranges cover ${plan.bytes} bytes of ${plan.media}, which is ${options.objectBytes}`
    )
  }
  const sourceKey = spaceKey(source, plan.media)
  await eachInFlight(plan.pieces, OBJECTS_IN_FLIGHT, async piece => {
    const bytes = await withSpaceRetry(async () => {
      const response = await doFetch(
        presignGetUrl({ ...space, key: sourceKey, expiresSec: 600 }),
        {
          headers: {
            range: `bytes=${piece.offset}-${piece.offset + piece.length - 1}`
          },
          // A socket the origin stops answering on is a try that failed, not
          // a script that waits for ever in the middle of a video.
          signal: AbortSignal.timeout(PIECE_TIMEOUT_MS)
        }
      )
      if (response.status !== 206) {
        await response.body?.cancel()
        const message = withoutSecrets(
          `${sourceKey} answered ${response.status} for ${piece.name}`
        )
        throw new SpaceRefusal(message, response.status)
      }
      return new Uint8Array(await response.arrayBuffer())
    })
    if (bytes.length !== piece.length) {
      throw new Error(
        `${piece.name} came back ${bytes.length} bytes, not ${piece.length}`
      )
    }
    if (!pieceLooksRight(piece, bytes)) {
      throw new Error(`${piece.name} is not a whole ${piece.kind}`)
    }
    await withSpaceRetry(async () => {
      await put({
        space,
        key: spaceKey(target, piece.name),
        body: Buffer.from(bytes),
        contentType: contentTypeFor(piece.name),
        signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
        ...uploadHeadersFor(target.spaceSecret, piece.name)
      })
    })
  })
}
