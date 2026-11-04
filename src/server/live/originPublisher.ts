import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  parseMediaPlaylist,
  type PlaylistSegment
} from '../media/wallClockScan'
import {
  isSegmentName,
  objectKey,
  publishedPlaylist,
  segmentNumber
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
 * Where each published playlist body goes besides the Space. `append` gets
 * the text a body added to the one before it; `replace` gets a whole body
 * that does not extend it (the first, or one a reconnect rewrote).
 */
export interface PlaylistSink {
  append: (videoId: string, text: string) => Promise<void>
  replace: (videoId: string, body: string) => Promise<void>
}

export const noPlaylistSink: PlaylistSink = {
  append: async () => {},
  replace: async () => {}
}
export interface OriginPublisherOptions {
  space: SpaceSettings
  videoId: string
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
  /** Reads the local playlist; the one shared reader of it by default. */
  playlist?: PlaylistTail
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

/** Lines, each with its newline. */
function linesText(lines: readonly string[]): string {
  let text = ''
  for (const line of lines) text += line + '\n'
  return text
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
  /** The body `appendBody` is building on, for one parse of the playlist. */
  private built?: {
    generation: number
    /** Pieces joined into `text`, after the header. */
    end: number
    text: string
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

  /** By `pieceKey`, as is `published`. */
  private readonly acknowledged = new Map<number, FileStamp>()
  private readonly published = new Set<number>()
  /** The count of leading pieces uploaded and unchanged, and the last one's number. */
  private cursor = 0
  private cursorNumber?: number
  /** The playlist's stamp at the last flush that left nothing to upload. */
  private settled?: { size: number; mtimeMs: number; result: OriginFlush }

  constructor(private readonly options: OriginPublisherOptions) {}

  stop(): void {
    this.stopped = true
  }

  /** Seed from remote checksums, never one GET per segment. */
  async start(): Promise<void> {
    if (this.started || !this.active()) return
    const body = await this.localPlaylist()
    if (body == null) return
    const { space, videoId } = this.options
    const entries = await listSpaceObjectEntries(space, `videos/${videoId}/`)
    const remote = new Map(entries.map(entry => [entry.key, entry]))
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: objectKey(videoId, 'index.m3u8'),
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
    for (const name of names) {
      const entry = remote.get(objectKey(videoId, name))
      if (entry == null) continue
      const local = await this.snapshot(name)
      if (local?.size === entry.size && local.md5 === entry.etag.toLowerCase())
        this.acknowledged.set(pieceKey(name), local)
    }
    this.masterWritten = remote.has(objectKey(videoId, 'master.m3u8'))
    this.started = true
  }

  async flush(options: { close?: boolean } = {}): Promise<OriginFlush> {
    if ((this.closing && options.close !== true) || !this.active())
      return { complete: false }
    await this.start()
    const stamp = await this.playlistStamp()
    const settled = this.settled
    if (
      stamp != null &&
      settled?.size === stamp.size &&
      settled.mtimeMs === stamp.mtimeMs
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
    if (view.publishedExact) objectKey(this.options.videoId, uri(0))
    else
      for (let index = 0; index < count; index++)
        objectKey(this.options.videoId, uri(index))
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
        this.options.isFinal(name) &&
        (await this.unchanged(name, this.acknowledged.get(segmentNumber(name))))
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
          const first = built.segment(0)
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
      this.settled = { ...stamp, result }
    return result
  }

  /**
   * The published body of a playlist `publishedPlaylist` would keep exactly,
   * built on from the last one: only the pieces it adds are joined on, and
   * only those are added to `published`. The pieces exposed before and the
   * published end are kept for the playlist's parse, so a flush that adds a
   * piece costs the same however many came before it.
   */
  private appendBody(
    view: PlaylistView,
    cursor: number,
    isAcknowledged: (index: number) => boolean
  ): PublishedBody {
    const count = view.count
    let held = this.built
    if (held?.generation !== view.generation) {
      let publishedEnd = 0
      for (const number of this.published) {
        const at = view.pieceAt(number)
        if (at == null)
          throw new Error('Local playlist lost a published segment')
        publishedEnd = Math.max(publishedEnd, at + 1)
      }
      held = {
        generation: view.generation,
        end: 0,
        text: linesText(view.header),
        publishedEnd,
        exposed: 0
      }
      this.built = held
    }
    // Every piece before the cursor is acknowledged.
    let acknowledgedEnd = cursor
    while (acknowledgedEnd < count && isAcknowledged(acknowledgedEnd))
      acknowledgedEnd++
    const end = Math.max(acknowledgedEnd, held.publishedEnd)
    const from = held.end
    if (end < from) held.text = linesText(view.header)
    const start = end < from ? 0 : from
    let added = ''
    for (let index = start; index < end; index++)
      added += linesText(view.piece(index).lines)
    held.text += added
    held.end = end
    const closed = view.ended && acknowledgedEnd === count
    const body =
      held.text === '' && !closed
        ? '\n'
        : held.text + (closed ? '#EXT-X-ENDLIST\n' : '')
    const last = this.lastBuilt
    const owner = held
    const built: PublishedBody = {
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
        ) {
          let text = last.end === start ? added : ''
          if (last.end !== start)
            for (let index = last.end; index < end; index++)
              text += linesText(view.piece(index).lines)
          return text + (closed ? '#EXT-X-ENDLIST\n' : '')
        }
        return body.startsWith(before) ? body.slice(before.length) : undefined
      }
    }
    return built
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
    const { space, videoId, dir } = this.options
    const key = objectKey(videoId, name)
    await putObjectFile({
      space,
      key,
      path: join(dir, name),
      contentType: contentTypeFor(name)
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
      key: objectKey(this.options.videoId, name),
      body: Buffer.from(body),
      contentType: contentTypeFor(name)
    })
  }

  private async probe(body: string): Promise<ProbedStream> {
    // A closed snapshot avoids waiting for more live input during ffprobe.
    const path = join(this.options.dir, '.origin-probe.m3u8')
    await writeFile(
      path,
      body.includes('#EXT-X-ENDLIST') ? body : body + '#EXT-X-ENDLIST\n'
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
