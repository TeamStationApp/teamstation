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
  readPart
} from '../media/wallClockScan'
import {
  isSegmentName,
  objectKey,
  publishedPlaylist,
  segmentEndsMs,
  segmentNumber,
  withoutSegments
} from './originPublish'

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
 * Reads a live recording's file from its directory, or, when the disk tail
 * has deleted it, from the Space, by a presigned GET of its key (with a
 * `Range` for a byte range). A close reads the whole recording this way.
 */
export function spacePartReader(
  space: SpaceSettings,
  video: VideoPath
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
      range == null
        ? {}
        : {
            headers: {
              range: `bytes=${range.offset}-${range.offset + range.length - 1}`
            }
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
   * again on each flush until the writer settles. None by default.
   */
  mayMove?: (name: string) => boolean
  onFirstSegment: (probe: ProbedStream) => Promise<void>
  /** A test may substitute a probe; object I/O still goes through HTTP. */
  probe?: (playlist: string) => Promise<ProbedStream>
  /** Receives each new body's added text; a no-op by default. */
  playlistSink?: PlaylistSink
  /** Defaults to `node:fs/promises`. */
  files?: OriginFiles
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
  private stopped = false
  private started = false
  private masterWritten = false
  private notified = false
  private metadata?: ProbedStream
  private lastBody?: string
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
    const onDisk = await this.localPlaylist()
    if (onDisk == null || !this.active()) return { complete: false }
    const playlist = parseMediaPlaylist(onDisk)
    if (playlist.segments.length === 0) return { complete: false }
    // Validate every name before performing any write.
    for (const segment of playlist.segments) objectKey(this.video, segment.uri)
    if (playlist.map?.uri !== 'init.mp4')
      throw new Error('Live playlist has no init.mp4 map')
    // A playlist that no longer holds the cursor's piece where it was is not
    // an append: check it all again.
    const segments = playlist.segments
    if (
      this.cursor > segments.length ||
      (this.cursor > 0 &&
        segmentNumber(segments[this.cursor - 1].uri) !== this.cursorNumber)
    )
      this.cursor = 0
    if (!(await this.publishFile('init.mp4'))) return { complete: false }
    let failure: unknown
    let failed = false
    for (const segment of segments.slice(this.cursor)) {
      if (this.isDeleted(segment.uri)) continue
      if (!this.options.isFinal(segment.uri)) break
      try {
        if (!(await this.publishFile(segment.uri))) break
      } catch (error) {
        failure = error
        failed = true
        break
      }
    }
    const acknowledged = new Set<string>(
      segments.slice(0, this.cursor).map(segment => segment.uri)
    )
    for (const segment of segments.slice(this.cursor)) {
      if (
        this.isDeleted(segment.uri) ||
        (this.options.isFinal(segment.uri) &&
          (await this.unchanged(
            segment.uri,
            this.acknowledged.get(segmentNumber(segment.uri))
          )))
      )
        acknowledged.add(segment.uri)
    }
    // A reconnect can replace the init while a slow segment upload runs.
    if (!(await this.unchanged('init.mp4', this.acknowledged.get(INIT_PIECE))))
      return { complete: false }
    const mayMove = this.options.mayMove ?? (() => false)
    while (
      this.cursor < segments.length &&
      acknowledged.has(segments[this.cursor].uri) &&
      !mayMove(segments[this.cursor].uri)
    )
      this.cursor++
    this.cursorNumber =
      this.cursor > 0 ? segmentNumber(segments[this.cursor - 1].uri) : undefined
    const body = publishedPlaylist(onDisk, acknowledged, this.published)
    const exposed = parseMediaPlaylist(body).segments
    if (exposed.length > 0 && this.active()) {
      if (body !== this.lastBody) {
        await this.putPlaylist('index.m3u8', body)
        const before = this.lastBody
        this.lastBody = body
        for (const segment of exposed)
          this.published.add(segmentNumber(segment.uri))
        const sink = this.options.playlistSink ?? noPlaylistSink
        if (before != null && body.startsWith(before))
          await sink.append(this.options.videoId, body.slice(before.length))
        else await sink.replace(this.options.videoId, body)
      }
      if (!this.notified && acknowledged.size > 0) {
        this.metadata ??= await this.probe(body)
        if (!this.masterWritten && this.active()) {
          const codecs = codecsAttribute(
            codecsFromInit(await readFile(join(this.options.dir, 'init.mp4')))
          )
          const first =
            exposed.find(segment => !this.isDeleted(segment.uri)) ?? exposed[0]
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
    await this.trimTail(onDisk, segments, mayMove, body)
    const result = {
      complete:
        playlist.ended &&
        acknowledged.size === segments.length &&
        this.lastBody === body &&
        this.notified &&
        !this.stopped,
      body
    }
    if (
      stamp != null &&
      this.cursor === segments.length &&
      this.lastBody === body &&
      this.notified &&
      this.active()
    )
      this.settled = { ...stamp, scanned, result }
    return result
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
    onDisk: string,
    segments: ReturnType<typeof parseMediaPlaylist>['segments'],
    mayMove: (name: string) => boolean,
    body: string
  ): Promise<void> {
    const tailSec = this.options.localTailSec ?? 0
    if (
      tailSec <= 0 ||
      this.closing ||
      !this.active() ||
      !this.notified ||
      this.lastBody !== body
    )
      return
    const scanned = this.options.scanned?.()
    if (scanned == null) return
    const ends = segmentEndsMs(onDisk)
    if (ends.length !== segments.length) return
    const limit = ends[ends.length - 1] - tailSec * 1000
    const before = Math.min(this.cursor, scanned.segments)
    const deletable = (index: number): boolean =>
      index < before &&
      index !== scanned.placementSegment &&
      ends[index] < limit &&
      !mayMove(segments[index].uri)
    for (const [number, index] of [...this.kept]) {
      const name = segments[index]?.uri
      if (
        index >= 0 &&
        name != null &&
        segmentNumber(name) === number &&
        deletable(index)
      ) {
        if (!(await this.deletePiece(name))) return
        this.kept.delete(number)
      }
    }
    let index = this.trimmed
    for (; index < before && ends[index] < limit; index++) {
      const name = segments[index].uri
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
    if (!this.active() || this.closing) return false
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
    await putObjectFile({
      space,
      key,
      path: join(dir, name),
      contentType: contentTypeFor(name),
      ...uploadHeadersFor(spaceSecret, name)
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
