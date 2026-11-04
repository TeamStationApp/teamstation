import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { codecsAttribute, codecsFromInit } from '../media/codecString'
import {
  ffprobeFor,
  type ProbedStream,
  probeVideoStream
} from '../media/ffmpeg'
import { putObject, putObjectFile } from '../media/images'
import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import {
  contentTypeFor,
  listSpaceObjectEntries,
  verifyObjectLength
} from '../media/spacesVideo'
import {
  uploadHeadersFor,
  type VideoPath,
  videoPrefix
} from '../media/videoPrefix'
import {
  parseMediaPlaylist,
  type PartReader,
  type PlaylistSegment,
  readPart
} from '../media/wallClockScan'
import {
  isSegmentName,
  objectKey,
  publishedPlaylist,
  segmentNumber,
  withoutSegments
} from './originPublish'
import {
  type PlaylistTail,
  playlistTail,
  type PlaylistView
} from './playlistTail'

interface FileStamp {
  size: number
  mtimeMs: number
  md5: string
}

/** `init.mp4`'s key among the pieces, which are keyed by sequence number. */
const INIT_PIECE = -1

/**
 * The key a piece is held under for the life of a recording: its sequence
 * number, or `INIT_PIECE`. A name parsed out of a playlist body is a slice of
 * that body, and holding one keeps the whole body alive, so a set of names
 * kept across flushes would keep every body the recording ever had.
 */
function pieceKey(name: string): number {
  return name === 'init.mp4' ? INIT_PIECE : segmentNumber(name)
}

/** The file system calls a flush makes per piece, injectable for counting. */
export interface OriginFiles {
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>
}

/**
 * How far the stream's wall clock scan has read its playlist: the pieces
 * before `segments` it does not read again, apart from `placementSegment`,
 * which it reads again after a restamp.
 */
export interface ScannedThrough {
  segments: number
  placementSegment?: number
}

/**
 * Where each published playlist body goes besides the Space. `append` gets
 * the text a body added to the one before it; `replace` gets a whole body
 * that does not extend it (the first, or one a reconnect rewrote).
 */
export interface PlaylistSink {
  append: (videoId: string, text: string) => Promise<void>
  replace: (videoId: string, body: string) => Promise<void>
}

/**
 * How long one read of a deleted piece from the Space may take, headers and
 * body. A piece is a few megabytes; a read that stalls would otherwise hold
 * the video's queue, and its close, for undici's five minutes.
 */
const PIECE_READ_TIMEOUT_MS = 30_000

/**
 * Reads a live recording's file from its directory, or, when the disk tail
 * has deleted it, from the Space, by a presigned GET of its key (with a
 * `Range` for a byte range). A close reads the whole recording this way.
 */
export function spacePartReader(
  space: SpaceSettings,
  video: VideoPath,
  timeoutMs = PIECE_READ_TIMEOUT_MS
): PartReader {
  return async (path, range) => {
    try {
      return await readPart(path, range)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const name = basename(path)
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: objectKey(video, name),
        expiresSec: 300
      }),
      {
        signal: AbortSignal.timeout(timeoutMs),
        ...(range == null
          ? {}
          : {
              headers: {
                range: `bytes=${range.offset}-${range.offset + range.length - 1}`
              }
            })
      }
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Reading ${name} from the Space answered ${response.status}`
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}

export const noPlaylistSink: PlaylistSink = {
  append: async () => {},
  replace: async () => {}
}
export interface OriginPublisherOptions {
  space: SpaceSettings
  videoId: string
  /**
   * The video's secret: its objects go under `videos/<id>-<secret>/`, pieces
   * and init files public. Null keeps a video from before secrets on
   * `videos/<id>/`, every object private, as it was.
   */
  spaceSecret: string | null
  dir: string
  ffmpegPath: string
  isFinal: (name: string) => boolean
  /**
   * A piece the writer may still rewrite in place (a continuation not yet
   * placed on the timeline). The cursor does not pass it, so it is checked
   * again on each flush until the writer settles. It is listed all the same,
   * so under a secret path it goes up `no-cache`: the copy that replaces it
   * after a restamp must not meet the old bytes at the edge. None by default.
   */
  mayMove?: (name: string) => boolean
  onFirstSegment: (probe: ProbedStream) => Promise<void>
  /** A test may substitute a probe; object I/O still goes through HTTP. */
  probe?: (playlist: string) => Promise<ProbedStream>
  /** Receives each new body's added text; a no-op by default. */
  playlistSink?: PlaylistSink
  /** Defaults to `node:fs/promises`. */
  files?: OriginFiles
  /** Reads the local playlist; the one shared reader of it by default. */
  playlist?: PlaylistTail
  /**
   * Seconds of the newest pieces kept on disk once the Space has them; 0, the
   * default, keeps every piece.
   */
  localTailSec?: number
  /**
   * How far the wall clock scan has read, or undefined before it has read
   * anything, when no piece is deleted.
   */
  scanned?: () => ScannedThrough | undefined
}

/** A published body, and how a flush that puts it carries on. */
interface PublishedBody {
  body: string
  /** How many media segments the body lists. */
  exposed: number
  segment: (index: number) => PlaylistSegment
  /** Adds the pieces the body lists to `published`, once it has been put. */
  expose: () => void
  /** The text the body adds to `before`, or undefined if it does not extend it. */
  after: (before: string | undefined) => string | undefined
}

export interface OriginFlush {
  complete: boolean
  body?: string
}

/**
 * One video's remote origin. Its caller serializes start, flush and close on
 * the video's own queue, so a slow store never holds the live controller tick.
 *
 * It asks the database nothing. Whether the video still exists is the
 * controller's to know, from its own sync: a deleted video's publisher is
 * stopped there, and a stopped publisher writes nothing more.
 *
 * A flush costs the same at any length of recording. It returns after one
 * `stat` while the local playlist is unchanged and everything in it is
 * published. Otherwise it checks `init.mp4` and only the pieces from its
 * acknowledged cursor onward: the pieces before the cursor were uploaded and
 * found unchanged once, and the writer only appends, so they are not opened
 * again.
 */
export class OriginPublisher {
  closing = false
  /**
   * Set when the recording starts to finish, before its playlist is closed:
   * from then on the tail deletes nothing, since the close reads what is on
   * disk, and asks whether anything was deleted, before `closing` is set.
   */
  holdPieces = false
  private stopped = false
  private started = false
  private masterWritten = false
  private notified = false
  private metadata?: ProbedStream
  private lastBody?: string
  /** What `appendBody` keeps of one parse of the playlist. */
  private built?: {
    generation: number
    /** One past the last piece whose number is in `published`. */
    publishedEnd: number
    /** Pieces before this one are all in `published`. */
    exposed: number
  }

  /** The last body `appendBody` built that was put, and what it held. */
  private lastBuilt?: {
    body: string
    generation: number
    end: number
    closed: boolean
  }

  /** By `pieceKey`, as are `published` and `kept`. */
  private readonly acknowledged = new Map<number, FileStamp>()
  private readonly published = new Set<number>()
  /** The count of leading pieces uploaded and unchanged, and the last one's number. */
  private cursor = 0
  private cursorNumber?: number
  /**
   * The playlist's stamp at the last flush that left nothing to upload, and
   * where the wall clock scan was then: a scan that has moved on may let the
   * tail delete more.
   */
  private settled?: {
    size: number
    mtimeMs: number
    scanned: string
    result: OriginFlush
  }

  /**
   * The highest sequence number deleted from disk. Those pieces are never
   * opened again, apart from the few the tail had to keep, in `kept`.
   */
  private deletedNumber = -1
  /**
   * Pieces the tail passed over and kept, by number, such as the wall clock scan's
   * placement piece, with their place in the playlist (-1 when a restart
   * found them on disk and does not know it yet).
   */
  private readonly kept = new Map<number, number>()
  /** How many leading playlist pieces the tail has deleted or kept. */
  private trimmed = 0

  constructor(private readonly options: OriginPublisherOptions) {}

  /** Where this video's objects go. */
  private get video(): VideoPath {
    return { id: this.options.videoId, spaceSecret: this.options.spaceSecret }
  }

  stop(): void {
    this.stopped = true
  }

  /** Whether any piece of this recording has left the disk. */
  get deletedAny(): boolean {
    return this.deletedNumber >= 0
  }

  /** Where the wall clock scan is, as far as the tail cares. */
  private scannedKey(): string {
    if ((this.options.localTailSec ?? 0) <= 0) return ''
    const scanned = this.options.scanned?.()
    return scanned == null
      ? ''
      : `${scanned.segments}:${scanned.placementSegment ?? ''}`
  }

  private isDeleted(name: string): boolean {
    return (
      isSegmentName(name) &&
      segmentNumber(name) <= this.deletedNumber &&
      !this.kept.has(segmentNumber(name))
    )
  }

  /** Seed from remote checksums, never one GET per segment. */
  async start(): Promise<void> {
    if (this.started || !this.active()) return
    const body = await this.localPlaylist()
    if (body == null) return
    const { space } = this.options
    const video = this.video
    const entries = await listSpaceObjectEntries(space, videoPrefix(video))
    const remote = new Map(entries.map(entry => [entry.key, entry]))
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: objectKey(video, 'index.m3u8'),
        expiresSec: 300
      })
    )
    if (response.ok) {
      const held = await response.text()
      for (const segment of parseMediaPlaylist(held).segments) {
        if (!isSegmentName(segment.uri))
          throw new Error('Invalid published live segment URI')
        this.published.add(segmentNumber(segment.uri))
      }
      this.lastBody = held
    } else {
      await response.body?.cancel()
      if (response.status !== 404)
        throw new Error(`Reading live origin answered ${response.status}`)
    }
    const names = [
      'init.mp4',
      ...parseMediaPlaylist(body).segments.map(segment => segment.uri)
    ]
    // Only what is on disk is seeded. A piece the Space holds and the disk
    // does not was deleted after it was acknowledged, so it stays so.
    const onDisk: string[] = []
    for (const name of names) {
      const entry = remote.get(objectKey(video, name))
      if (entry == null) continue
      const local = await this.snapshot(name).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (local === null) {
        if (isSegmentName(name))
          this.deletedNumber = Math.max(this.deletedNumber, segmentNumber(name))
        continue
      }
      if (isSegmentName(name)) onDisk.push(name)
      if (local?.size === entry.size && local.md5 === entry.etag.toLowerCase())
        this.acknowledged.set(pieceKey(name), local)
    }
    for (const name of onDisk)
      if (segmentNumber(name) < this.deletedNumber)
        this.kept.set(segmentNumber(name), -1)
    this.masterWritten = remote.has(objectKey(video, 'master.m3u8'))
    this.started = true
  }

  async flush(options: { close?: boolean } = {}): Promise<OriginFlush> {
    if ((this.closing && options.close !== true) || !this.active())
      return { complete: false }
    await this.start()
    const stamp = await this.playlistStamp()
    const settled = this.settled
    const scanned = this.scannedKey()
    if (
      stamp != null &&
      settled?.size === stamp.size &&
      settled.mtimeMs === stamp.mtimeMs &&
      settled.scanned === scanned
    )
      return settled.result
    this.settled = undefined
    const view = this.options.playlist?.read() ?? this.readPlaylist()
    if (view == null || !this.active()) return { complete: false }
    const count = view.count
    if (count === 0) return { complete: false }
    const uri = (index: number): string => view.segment(index).uri
    // Validate every name before performing any write. A playlist whose
    // pieces are all piece names needs only the video checked.
    if (view.publishedExact) objectKey(this.video, uri(0))
    else
      for (let index = 0; index < count; index++)
        objectKey(this.video, uri(index))
    if (view.map?.uri !== 'init.mp4')
      throw new Error('Live playlist has no init.mp4 map')
    // A playlist that no longer holds the cursor's piece where it was is not
    // an append: check it all again.
    if (
      this.cursor > count ||
      (this.cursor > 0 &&
        segmentNumber(uri(this.cursor - 1)) !== this.cursorNumber)
    )
      this.cursor = 0
    if (!(await this.publishFile('init.mp4'))) return { complete: false }
    let failure: unknown
    let failed = false
    for (let index = this.cursor; index < count; index++) {
      const name = uri(index)
      if (this.isDeleted(name)) continue
      if (!this.options.isFinal(name)) break
      try {
        if (!(await this.publishFile(name))) break
      } catch (error) {
        failure = error
        failed = true
        break
      }
    }
    // Every piece before the cursor is acknowledged; of the rest, `fresh`.
    const from = this.cursor
    const fresh = new Set<string>()
    for (let index = from; index < count; index++) {
      const name = uri(index)
      if (
        this.isDeleted(name) ||
        (this.options.isFinal(name) &&
          (await this.unchanged(
            name,
            this.acknowledged.get(segmentNumber(name))
          )))
      )
        fresh.add(name)
    }
    // A playlist that names a piece twice keeps the whole set, as names.
    const named = view.publishedExact
      ? undefined
      : new Set<string>([
          ...Array.from({ length: from }, (_, index) => uri(index)),
          ...fresh
        ])
    const isAcknowledged = (index: number): boolean =>
      named == null
        ? index < from || fresh.has(uri(index))
        : named.has(uri(index))
    const acknowledgedCount = named?.size ?? from + fresh.size
    // A reconnect can replace the init while a slow segment upload runs.
    if (!(await this.unchanged('init.mp4', this.acknowledged.get(INIT_PIECE))))
      return { complete: false }
    const mayMove = this.options.mayMove ?? (() => false)
    while (
      this.cursor < count &&
      isAcknowledged(this.cursor) &&
      !mayMove(uri(this.cursor))
    )
      this.cursor++
    this.cursorNumber =
      this.cursor > 0 ? segmentNumber(uri(this.cursor - 1)) : undefined
    const built =
      named == null
        ? this.appendBody(view, from, isAcknowledged)
        : this.wholeBody(view, named)
    const { body, exposed } = built
    if (exposed > 0 && this.active()) {
      if (body !== this.lastBody) {
        await this.putPlaylist('index.m3u8', body)
        const before = this.lastBody
        this.lastBody = body
        built.expose()
        const sink = this.options.playlistSink ?? noPlaylistSink
        const added = built.after(before)
        if (added != null) await sink.append(this.options.videoId, added)
        else await sink.replace(this.options.videoId, body)
      }
      if (!this.notified && acknowledgedCount > 0) {
        this.metadata ??= await this.probe(body)
        if (!this.masterWritten && this.active()) {
          const codecs = codecsAttribute(
            codecsFromInit(await readFile(join(this.options.dir, 'init.mp4')))
          )
          let first = built.segment(0)
          for (let index = 0; index < exposed; index++) {
            if (!this.isDeleted(built.segment(index).uri)) {
              first = built.segment(index)
              break
            }
          }
          const bytes = (await this.stat(join(this.options.dir, first.uri)))
            .size
          // Include every track's bytes; HLS probes commonly report no bitrate.
          const bandwidth = Math.max(
            1,
            Math.ceil(((bytes * 8) / first.durationSec) * 1.1)
          )
          const { width, height } = this.metadata
          const attributes = [
            `BANDWIDTH=${bandwidth}`,
            ...(width == null || height == null
              ? []
              : [`RESOLUTION=${width}x${height}`]),
            ...(codecs === '' ? [] : [`CODECS="${codecs}"`])
          ]
          await this.putPlaylist(
            'master.m3u8',
            `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:${attributes.join(',')}\nindex.m3u8\n`
          )
          this.masterWritten = true
        }
        if (this.active()) {
          await this.options.onFirstSegment(this.metadata)
          this.notified = true
        }
      }
    }
    if (failed) throw failure
    await this.trimTail(view, mayMove, body)
    const result = {
      complete:
        view.ended &&
        acknowledgedCount === count &&
        this.lastBody === body &&
        this.notified &&
        !this.stopped,
      body
    }
    if (
      stamp != null &&
      this.cursor === count &&
      this.lastBody === body &&
      this.notified &&
      this.active()
    )
      this.settled = { ...stamp, scanned, result }
    return result
  }

  /**
   * The published body of a playlist `publishedPlaylist` would keep exactly:
   * the playlist's own text up to the end of the last piece it publishes,
   * with the end tag once it is complete. Only the pieces it adds are added
   * to `published`, and the published end is kept for the playlist's parse,
   * so a flush that adds a piece costs the same however many came before it.
   */
  private appendBody(
    view: PlaylistView,
    cursor: number,
    isAcknowledged: (index: number) => boolean
  ): PublishedBody {
    const count = view.count
    let held = this.built
    if (held?.generation !== view.generation) {
      // A new parse: every published piece must still be listed.
      const listed = new Map<number, number>()
      for (let index = 0; index < count; index++)
        listed.set(segmentNumber(view.segment(index).uri), index)
      let publishedEnd = 0
      for (const number of this.published) {
        const at = listed.get(number)
        if (at == null)
          throw new Error('Local playlist lost a published segment')
        publishedEnd = Math.max(publishedEnd, at + 1)
      }
      held = { generation: view.generation, publishedEnd, exposed: 0 }
      this.built = held
    }
    // Every piece before the cursor is acknowledged.
    let acknowledgedEnd = cursor
    while (acknowledgedEnd < count && isAcknowledged(acknowledgedEnd))
      acknowledgedEnd++
    const end = Math.max(acknowledgedEnd, held.publishedEnd)
    const closed = view.ended && acknowledgedEnd === count
    const closing = closed ? '#EXT-X-ENDLIST\n' : ''
    const text = view.bodyText(end)
    const body = text === '' && !closed ? '\n' : text + closing
    const last = this.lastBuilt
    const owner = held
    return {
      body,
      exposed: end,
      segment: index => view.segment(index),
      expose: () => {
        for (let index = owner.exposed; index < end; index++)
          this.published.add(segmentNumber(view.segment(index).uri))
        owner.exposed = Math.max(owner.exposed, end)
        owner.publishedEnd = Math.max(owner.publishedEnd, end)
        this.lastBuilt =
          body === '\n'
            ? undefined
            : { body, generation: view.generation, end, closed }
      },
      after: before => {
        if (before == null) return undefined
        if (
          last?.body === before &&
          last.generation === view.generation &&
          !last.closed &&
          last.end <= end
        )
          return view.bodyBetween(last.end, end) + closing
        return body.startsWith(before) ? body.slice(before.length) : undefined
      }
    }
  }

  /** The published body of any other playlist, from its whole text. */
  private wholeBody(
    view: PlaylistView,
    named: ReadonlySet<string>
  ): PublishedBody {
    this.built = undefined
    this.lastBuilt = undefined
    const body = publishedPlaylist(view.text(), named, this.published)
    const exposed = parseMediaPlaylist(body).segments
    return {
      body,
      exposed: exposed.length,
      segment: index => exposed[index],
      expose: () => {
        for (const segment of exposed)
          this.published.add(segmentNumber(segment.uri))
      },
      after: before =>
        before != null && body.startsWith(before)
          ? body.slice(before.length)
          : undefined
    }
  }

  /**
   * Deletes from disk each piece the tail no longer needs: one acknowledged
   * (before the cursor, so uploaded, verified by length and unchanged since),
   * that the wall clock scan has read and will not read again, that the
   * writer can no longer restamp, and that ended more than `localTailSec`
   * before the newest piece, by program date time. Only once the published
   * playlist lists it, and never while closing. Each pass starts where the
   * last stopped, so it costs the same at any length of recording.
   */
  private async trimTail(
    view: PlaylistView,
    mayMove: (name: string) => boolean,
    body: string
  ): Promise<void> {
    const tailSec = this.options.localTailSec ?? 0
    if (
      tailSec <= 0 ||
      this.closing ||
      this.holdPieces ||
      !this.active() ||
      !this.notified ||
      this.lastBody !== body
    )
      return
    const scanned = this.options.scanned?.()
    if (scanned == null) return
    const count = view.count
    const limit = view.endMs(count - 1) - tailSec * 1000
    const before = Math.min(this.cursor, scanned.segments)
    const deletable = (index: number): boolean =>
      index < Math.min(before, count) &&
      index !== scanned.placementSegment &&
      view.endMs(index) < limit &&
      !mayMove(view.segment(index).uri)
    for (const [number, index] of [...this.kept]) {
      const name =
        index >= 0 && index < count ? view.segment(index).uri : undefined
      if (
        index >= 0 &&
        name != null &&
        segmentNumber(name) === number &&
        deletable(index)
      ) {
        if (!(await this.deletePiece(name))) return
        this.kept.delete(number)
        // Every piece before `trimmed` is deleted or kept, so this marks
        // nothing on disk as gone, and a flush that checks the playlist
        // again from the start skips this one.
        this.deletedNumber = Math.max(this.deletedNumber, number)
      }
    }
    let index = this.trimmed
    for (
      ;
      index < Math.min(before, count) && view.endMs(index) < limit;
      index++
    ) {
      const name = view.segment(index).uri
      if (this.isDeleted(name)) continue
      if (!deletable(index)) {
        this.kept.set(segmentNumber(name), index)
        continue
      }
      if (!(await this.deletePiece(name))) break
      this.kept.delete(segmentNumber(name))
      this.deletedNumber = Math.max(this.deletedNumber, segmentNumber(name))
    }
    this.trimmed = index
  }

  private async deletePiece(name: string): Promise<boolean> {
    if (!this.active() || this.closing || this.holdPieces) return false
    await unlink(join(this.options.dir, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    this.acknowledged.delete(pieceKey(name))
    return true
  }

  private async stat(path: string): Promise<{ size: number; mtimeMs: number }> {
    return await (this.options.files ?? { stat }).stat(path)
  }

  private async playlistStamp(): Promise<
    { size: number; mtimeMs: number } | undefined
  > {
    try {
      const info = await this.stat(join(this.options.dir, 'master.m3u8'))
      return { size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return undefined
    }
  }

  private active(): boolean {
    return !this.stopped
  }

  /** The local playlist, read on from the last read (`playlistTail`). */
  private readPlaylist(): PlaylistView | undefined {
    return playlistTail(join(this.options.dir, 'master.m3u8')).read()
  }

  private async localPlaylist(): Promise<string | undefined> {
    try {
      return await readFile(join(this.options.dir, 'master.m3u8'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async unchanged(name: string, held?: FileStamp): Promise<boolean> {
    if (held == null) return false
    const info = await this.stat(join(this.options.dir, name)).catch(
      () => undefined
    )
    return info?.size === held.size && info.mtimeMs === held.mtimeMs
  }

  private async snapshot(name: string): Promise<FileStamp | undefined> {
    const path = join(this.options.dir, name)
    const info = await this.stat(path)
    // A writer creates a file before it fills it, and a reconnecting one
    // truncates the init it rewrites: nothing is uploaded until it has bytes
    // and holds still while it is read.
    if (info.size === 0) return undefined
    const hash = createHash('md5')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    const held = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      md5: hash.digest('hex')
    }
    return (await this.unchanged(name, held)) ? held : undefined
  }

  private async publishFile(name: string): Promise<boolean> {
    if (await this.unchanged(name, this.acknowledged.get(pieceKey(name))))
      return true
    if (!this.active()) return false
    this.acknowledged.delete(pieceKey(name))
    const held = await this.snapshot(name)
    if (held == null || !this.active()) return false
    const { space, dir, spaceSecret } = this.options
    const key = objectKey(this.video, name)
    const headers = uploadHeadersFor(spaceSecret, name)
    if (headers.cacheControl != null && this.options.mayMove?.(name) === true)
      headers.cacheControl = 'no-cache'
    await putObjectFile({
      space,
      key,
      path: join(dir, name),
      contentType: contentTypeFor(name),
      ...headers
    })
    const result = await verifyObjectLength({ space, key, size: held.size })
    if (!result.ok) throw new Error(result.reason)
    if (!(await this.unchanged(name, held))) return false
    this.acknowledged.set(pieceKey(name), held)
    return true
  }

  private async putPlaylist(name: string, body: string): Promise<void> {
    if (!this.active()) return
    await putObject({
      space: this.options.space,
      key: objectKey(this.video, name),
      body: Buffer.from(body),
      contentType: contentTypeFor(name)
    })
  }

  private async probe(body: string): Promise<ProbedStream> {
    // A closed snapshot avoids waiting for more live input during ffprobe.
    const path = join(this.options.dir, '.origin-probe.m3u8')
    // Only what is still on disk: after a restart, the first pieces may be
    // gone.
    const held = this.deletedAny
      ? withoutSegments(body, name => this.isDeleted(name))
      : body
    await writeFile(
      path,
      held.includes('#EXT-X-ENDLIST') ? held : held + '#EXT-X-ENDLIST\n'
    )
    try {
      return await (
        this.options.probe ??
        (async path =>
          await probeVideoStream(ffprobeFor(this.options.ffmpegPath), path))
      )(path)
    } finally {
      await rm(path, { force: true })
    }
  }
}
