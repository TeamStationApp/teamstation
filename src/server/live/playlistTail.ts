import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { resolve } from 'path'

import type { MediaPlaylist, PlaylistSegment } from '../media/wallClockScan'
import { isSegmentName, segmentNumber } from './originPublish'
import type { ListedSegment } from './segmentClock'

/**
 * A live playlist read as it grows.
 *
 * The writer only ever adds to the end of its playlist, so once a playlist
 * has been read, the next read takes only the bytes added since and extends
 * what it parsed. A read that finds the playlist did not just grow — it was
 * rewritten, it shrank, or a reconnect's `append_list` rewrote its header —
 * reads and parses it all again, as a first read does. Each read costs the
 * same at the first piece of a game as at the three-thousandth.
 *
 * The playlist "just grew" when it is at least as long as before and both its
 * first and its last `WINDOW_BYTES` before the old length are as they were.
 * The header carries everything a rewrite changes there (the target
 * duration, the media sequence), and the end of the old text holds the last
 * piece's lines, which the only in-place edits (the last length settled, an
 * `EXT-X-ENDLIST` taken off) change.
 *
 * Only whole lines are parsed. A playlist caught part way through a write,
 * which does not end in a newline, is parsed whole for that one read and
 * read whole again the next time.
 *
 * Every parse here is the same, line for line, as the whole-text parse it
 * stands in for: `parseMediaPlaylist`, `listedSegments`, `segmentEndsMs` and
 * the lines `publishedPlaylist` keeps.
 */

/** How much of the old text's start and end must be unchanged for an append. */
export const WINDOW_BYTES = 1024

/** The calls a read makes, injectable for counting. */
export interface TailFiles {
  readFileSync: (path: string) => Buffer
  openSync: (path: string, flags: 'r') => number
  fstatSync: (fd: number) => { size: number }
  readSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => number
  closeSync: (fd: number) => void
}

/** Node's own, looked up on each call so a test can stand in for them. */
const nodeFiles: TailFiles = {
  readFileSync: path => readFileSync(path),
  openSync: (path, flags) => openSync(path, flags),
  fstatSync: fd => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  closeSync: fd => {
    closeSync(fd)
  }
}

/** One piece as `publishedPlaylist` keeps it: its lines, ending with its name. */
export interface PublishedPiece {
  name: string
  lines: string[]
}

/** A read playlist, as it was when it was read. */
export interface PlaylistView {
  /** Changes whenever the playlist was parsed again from its start. */
  readonly generation: number
  /** Media segments, as `parseMediaPlaylist` lists them. */
  readonly count: number
  readonly map: MediaPlaylist['map']
  readonly ended: boolean
  segment: (index: number) => PlaylistSegment
  /** Where segment `index` starts, in ms of `EXTINF`; `index` up to `count`. */
  startMs: (index: number) => number
  /** Where segment `index` ends, as `segmentEndsMs` has it. */
  endMs: (index: number) => number
  /** Segments as `listedSegments` lists them. */
  readonly listedCount: number
  listed: (index: number) => ListedSegment
  /** The first place `name` is listed, if it is among the first `listedCount`. */
  listedAt: (name: string) => number | undefined
  /**
   * Whether `publishedPlaylist` would keep exactly `header` and one piece
   * per media segment, in order, with the lines `piece` gives: every name a
   * piece name, none twice, each with an `EXTINF`, and the trimmed end of the
   * text taking nothing off a piece's line.
   */
  readonly publishedExact: boolean
  readonly header: readonly string[]
  piece: (index: number) => PublishedPiece
  /** Where piece number `number` is, among the first `count`. */
  pieceAt: (number: number) => number | undefined
  /** The parsed playlist as `parseMediaPlaylist` gives it. */
  mediaPlaylist: () => MediaPlaylist
  /** The whole text that was read. */
  text: () => string
}

const PROGRAM_DATE = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/
const LISTED_DURATION = /^#EXTINF:([\d.]+)/
const LISTED_NAME = /^seg\d+\.m4s$/
const MEDIA_TAG =
  /^(?:#EXTINF:|#EXT-X-DISCONTINUITY$|#EXT-X-PROGRAM-DATE-TIME:)/

let generations = 0

/** Everything parsed out of a playlist so far, one line at a time. */
class PlaylistParse {
  readonly generation = ++generations
  /** Every line, as split on `\n`. */
  readonly lines: string[] = []

  // As `parseMediaPlaylist`.
  map: MediaPlaylist['map']
  readonly segments: PlaylistSegment[] = []
  ended = false
  private duration: number | undefined
  private range: PlaylistSegment['range']
  private discontinuity = false
  private rangeEnd = 0
  /** `startsMs[i]` is where segment `i` starts; one more than `segments`. */
  readonly startsMs: number[] = [0]

  // As `segmentEndsMs`.
  readonly ends: number[] = []
  private dated: number | undefined
  private endDuration: number | undefined
  private end = 0

  // As `listedSegments`.
  readonly listed: ListedSegment[] = []
  readonly listedFirst = new Map<string, number>()
  private pendingSec: number | undefined
  private pendingPdt: number | undefined

  // As `publishedPlaylist`.
  readonly header: string[] = []
  readonly pieces: PublishedPiece[] = []
  readonly pieceFirst = new Map<number, number>()
  private pending: string[] = []
  private media = false
  /** A name that is not a piece's, or a piece listed twice. */
  irregular = false
  /** The last line with text is a piece's name with space after it. */
  spaceAfterLastName = false

  add(raw: string): void {
    this.lines.push(raw)
    const line = raw.trim()
    this.addMedia(line)
    this.addEnd(line)
    this.addListed(line)
    this.addPublished(raw.endsWith('\r') ? raw.slice(0, -1) : raw, line)
  }

  private readRange(value: string): { offset: number; length: number } {
    const [length, offset] = value.split('@').map(Number)
    const at = offset ?? this.rangeEnd
    this.rangeEnd = at + length
    return { offset: at, length }
  }

  private addMedia(line: string): void {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]*)"/.exec(line)?.[1] ?? ''
      const byterange = /BYTERANGE="([^"]*)"/.exec(line)?.[1]
      this.map = {
        uri,
        ...(byterange == null ? {} : { range: this.readRange(byterange) })
      }
    } else if (line.startsWith('#EXTINF:')) {
      this.duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      this.range = this.readRange(line.slice('#EXT-X-BYTERANGE:'.length))
    } else if (line === '#EXT-X-DISCONTINUITY') {
      this.discontinuity = true
    } else if (line === '#EXT-X-ENDLIST') {
      this.ended = true
    } else if (line !== '' && !line.startsWith('#') && this.duration != null) {
      this.segments.push({
        uri: line,
        durationSec: this.duration,
        ...(this.range == null ? {} : { range: this.range }),
        discontinuity: this.discontinuity
      })
      this.startsMs.push(
        this.startsMs[this.startsMs.length - 1] + this.duration * 1000
      )
      this.duration = undefined
      this.range = undefined
      this.discontinuity = false
    }
  }

  private addEnd(line: string): void {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const at = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length))
      this.dated = Number.isNaN(at) ? undefined : at
    } else if (line.startsWith('#EXTINF:')) {
      this.endDuration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (
      line !== '' &&
      !line.startsWith('#') &&
      this.endDuration != null
    ) {
      this.end = (this.dated ?? this.end) + this.endDuration * 1000
      this.ends.push(this.end)
      this.dated = undefined
      this.endDuration = undefined
    }
  }

  private addListed(line: string): void {
    const dated = PROGRAM_DATE.exec(line)
    if (dated != null) {
      const ms = Date.parse(dated[1])
      if (Number.isFinite(ms)) this.pendingPdt = ms
    }
    const duration = LISTED_DURATION.exec(line)
    if (duration != null) this.pendingSec = Number.parseFloat(duration[1])
    if (!LISTED_NAME.test(line)) return
    if (this.pendingSec != null) {
      if (!this.listedFirst.has(line))
        this.listedFirst.set(line, this.listed.length)
      this.listed.push({
        name: line,
        durationSec: this.pendingSec,
        ...(this.pendingPdt == null ? {} : { programDateMs: this.pendingPdt })
      })
    }
    this.pendingSec = undefined
    this.pendingPdt = undefined
  }

  private addPublished(raw: string, text: string): void {
    if (text !== '') this.spaceAfterLastName = false
    if (text === '#EXT-X-ENDLIST') return
    if (text !== '' && !text.startsWith('#')) {
      if (isSegmentName(text)) {
        const number = segmentNumber(text)
        if (this.pieceFirst.has(number)) this.irregular = true
        else this.pieceFirst.set(number, this.pieces.length)
      } else this.irregular = true
      this.pieces.push({ name: text, lines: [...this.pending, raw] })
      this.pending = []
      this.media = true
      this.spaceAfterLastName = raw !== raw.trimEnd()
    } else {
      if (MEDIA_TAG.test(text)) this.media = true
      if (this.media) this.pending.push(raw)
      else this.header.push(raw)
    }
  }

  view(complete: boolean): PlaylistView {
    const count = this.segments.length
    const listedCount = this.listed.length
    const pieces = this.pieces.length
    const headerCount = this.header.length
    const lineCount = this.lines.length
    const { map, ended } = this
    const publishedExact =
      complete &&
      !this.irregular &&
      !this.spaceAfterLastName &&
      pieces === count
    return {
      generation: this.generation,
      count,
      map,
      ended,
      segment: index => this.segments[index],
      startMs: index => this.startsMs[index],
      endMs: index => this.ends[index],
      listedCount,
      listed: index => this.listed[index],
      listedAt: name => {
        const at = this.listedFirst.get(name)
        return at != null && at < listedCount ? at : undefined
      },
      publishedExact,
      header: this.header.slice(0, headerCount),
      piece: index => this.pieces[index],
      pieceAt: number => {
        const at = this.pieceFirst.get(number)
        return at != null && at < pieces ? at : undefined
      },
      mediaPlaylist: () => ({
        ...(map == null ? {} : { map }),
        segments: this.segments.slice(0, count),
        ended
      }),
      text: () =>
        this.lines.slice(0, lineCount).join('\n') + (complete ? '\n' : '')
    }
  }
}

/** Whole lines of `text`, and whether it ended in a newline. */
function linesOf(text: string): { lines: string[]; complete: boolean } {
  const lines = text.split('\n')
  const complete = lines[lines.length - 1] === ''
  if (complete) lines.pop()
  return { lines, complete }
}

/** One playlist file, read as it grows. */
export class PlaylistTail {
  /** Bytes read from the file, for a test to count. */
  bytesRead = 0
  private parse?: PlaylistParse
  private length = 0
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private current?: PlaylistView

  constructor(
    readonly path: string,
    private readonly files: TailFiles = nodeFiles
  ) {}

  /**
   * The playlist as it is now, or undefined while there is none. Any other
   * failure to read it is thrown.
   */
  read(): PlaylistView | undefined {
    try {
      return this.parse == null ? this.readWhole() : this.readAdded(this.parse)
    } catch (error) {
      this.forget()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private forget(): void {
    this.parse = undefined
    this.current = undefined
    this.length = 0
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
  }

  private readWhole(): PlaylistView {
    const bytes = this.files.readFileSync(this.path)
    this.bytesRead += bytes.length
    const parse = new PlaylistParse()
    const { lines, complete } = linesOf(bytes.toString('utf8'))
    for (const line of lines) parse.add(line)
    const view = parse.view(complete)
    if (!complete) {
      this.forget()
      return view
    }
    this.parse = parse
    this.length = bytes.length
    this.head = Buffer.from(bytes.subarray(0, WINDOW_BYTES))
    this.tail = Buffer.from(
      bytes.subarray(Math.max(0, bytes.length - WINDOW_BYTES))
    )
    this.current = view
    return view
  }

  private readAdded(parse: PlaylistParse): PlaylistView {
    const fd = this.files.openSync(this.path, 'r')
    let added: Buffer
    try {
      const size = this.files.fstatSync(fd).size
      if (size < this.length) {
        this.forget()
        return this.readWhole()
      }
      const head = this.readAt(fd, 0, Math.min(WINDOW_BYTES, size))
      const tailAt = this.length - this.tail.length
      const rest = this.readAt(fd, tailAt, size - tailAt)
      if (
        head.length < this.head.length ||
        !head.subarray(0, this.head.length).equals(this.head) ||
        rest.length < this.tail.length ||
        !rest.subarray(0, this.tail.length).equals(this.tail)
      ) {
        this.forget()
        return this.readWhole()
      }
      added = rest.subarray(this.tail.length)
      if (added.length === 0 && this.current != null) return this.current
      const end = added.lastIndexOf(0x0a)
      if (end !== added.length - 1) {
        // Caught part way through a write: this read is parsed whole.
        this.forget()
        return this.readWhole()
      }
      this.length = size
      this.head = Buffer.from(head)
      this.tail = Buffer.from(
        rest.subarray(rest.length - Math.min(WINDOW_BYTES, size))
      )
    } finally {
      this.files.closeSync(fd)
    }
    const { lines } = linesOf(added.toString('utf8'))
    for (const line of lines) parse.add(line)
    this.current = parse.view(true)
    return this.current
  }

  private readAt(fd: number, position: number, length: number): Buffer {
    const buffer = Buffer.alloc(Math.max(0, length))
    let filled = 0
    while (filled < buffer.length) {
      const got = this.files.readSync(
        fd,
        buffer,
        filled,
        buffer.length - filled,
        position + filled
      )
      if (got === 0) break
      filled += got
    }
    this.bytesRead += filled
    return buffer.subarray(0, filled)
  }
}

/** How many playlists are held at once; the oldest read goes first. */
export const HELD_PLAYLISTS = 128

const held = new Map<string, PlaylistTail>()

/**
 * The one reader of the playlist at `path`, shared by everything that reads
 * it: the uploader's flush, the wall clock scan and the writer's own count of
 * final pieces each read the same playlist every few seconds.
 */
export function playlistTail(path: string): PlaylistTail {
  const key = resolve(path)
  let reader = held.get(key)
  if (reader == null) reader = new PlaylistTail(key)
  else held.delete(key)
  held.set(key, reader)
  while (held.size > HELD_PLAYLISTS) {
    const oldest = held.keys().next().value
    if (oldest == null) break
    held.delete(oldest)
  }
  return reader
}
