import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { resolve } from 'path'

import type { MediaPlaylist, PlaylistSegment } from '../media/wallClockScan'
import { isSegmentName, segmentNumber } from './originPublish'
import { FIRST_INIT, type ListedSegment } from './segmentClock'

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
 * stands in for: `parseMediaPlaylist`, `listedSegments` and
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

/** A read playlist, as it was when it was read. */
export interface PlaylistView {
  /** Changes whenever the playlist was parsed again from its start. */
  readonly generation: number
  /** Media segments, as `parseMediaPlaylist` lists them. */
  readonly count: number
  /** The first `EXT-X-MAP`; a later one is on the segments under it. */
  readonly map: MediaPlaylist['map']
  /**
   * Every init segment a map names for the first map or a segment under it,
   * in order, each once: a recording continued by a differently configured
   * camera has one per part.
   */
  readonly inits: readonly string[]
  /** Each part's init segment and its first listed segment, in order. */
  readonly parts: ReadonlyArray<{
    init: string
    name: string
    durationSec: number
  }>
  readonly ended: boolean
  segment: (index: number) => PlaylistSegment
  /** Where segment `index` starts, in ms of `EXTINF`; `index` up to `count`. */
  startMs: (index: number) => number
  /** Segments as `listedSegments` lists them. */
  readonly listedCount: number
  listed: (index: number) => ListedSegment
  /** The first place `name` is listed, if it is among the first `listedCount`. */
  listedAt: (name: string) => number | undefined
  /**
   * Whether the body `publishedPlaylist` keeps of the first `end` pieces is
   * the text up to the end of piece `end`'s name: one piece per media
   * segment, each a piece name numbered above the one before, no carriage
   * return and no `EXT-X-ENDLIST` before a piece, and the trimmed end of the
   * text taking nothing off a piece's line.
   */
  readonly publishedExact: boolean
  /** The text of the header and the first `end` pieces, when exact. */
  bodyText: (end: number) => string
  /** The text pieces `from` to `to` add to `bodyText(from)`, when exact. */
  bodyBetween: (from: number, to: number) => string
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
  /** The text parsed, and how much of it is whole lines. */
  text = ''
  private parsed = 0

  // As `parseMediaPlaylist`.
  map: MediaPlaylist['map']
  /** The map in force after the first, which the segments under it carry. */
  private later: MediaPlaylist['map']
  readonly segments: PlaylistSegment[] = []
  /** As `initsOf`: the first map's init segment, then each later one's. */
  readonly inits: string[] = []
  private readonly initsSeen = new Set<string>()
  ended = false
  private duration: number | undefined
  private range: PlaylistSegment['range']
  private discontinuity = false
  private rangeEnd = 0
  /** `startsMs[i]` is where segment `i` starts; one more than `segments`. */
  readonly startsMs: number[] = [0]

  // As `listedSegments`.
  readonly listed: ListedSegment[] = []
  /** Listed names numbered upwards, so found by their number. */
  private listedRising = true
  /** Where each name is first listed, once they do not rise; built on asking. */
  private listedFirst?: { at: Map<string, number>; through: number }
  private pendingSec: number | undefined
  private pendingPdt: number | undefined
  /** The init segment the `EXT-X-MAP` above names, as `listedSegments` has it. */
  private listedInit = FIRST_INIT
  /** Each init segment's first listed segment, in order. */
  readonly parts: Array<{ init: string; name: string; durationSec: number }> =
    []

  private readonly partsSeen = new Set<string>()

  // As `publishedPlaylist`: where in the text the header and each piece end.
  private headerEnd = 0
  readonly pieceEnds: number[] = []
  private media = false
  private lastNumber = -1
  private endBeforePiece = false
  /** Something the published body does not keep as the text has it. */
  irregular = false
  /** The last line with text is a piece's name with space after it. */
  spaceAfterLastName = false

  /** Parses `text`, read on from the text before it. */
  addText(text: string): void {
    this.text += text
    const lines = text.split('\n')
    // The last line goes on unless the text ended one.
    if (lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      this.parsed += line.length + 1
      this.add(line)
    }
  }

  private add(raw: string): void {
    const line = raw.trim()
    this.addMedia(line)
    this.addListed(line)
    this.addPublished(raw, line)
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
      const map = {
        uri,
        ...(byterange == null ? {} : { range: this.readRange(byterange) })
      }
      if (this.map == null) {
        this.map = map
        this.noteInit(uri)
      } else this.later = map
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
        ...(this.later == null ? {} : { map: this.later }),
        discontinuity: this.discontinuity
      })
      if (this.later != null) this.noteInit(this.later.uri)
      this.startsMs.push(
        this.startsMs[this.startsMs.length - 1] + this.duration * 1000
      )
      this.duration = undefined
      this.range = undefined
      this.discontinuity = false
    }
  }

  private noteInit(uri: string): void {
    if (this.initsSeen.has(uri)) return
    this.initsSeen.add(uri)
    this.inits.push(uri)
  }

  private addListed(line: string): void {
    if (line.startsWith('#EXT-X-MAP:'))
      this.listedInit = /URI="([^"]+)"/.exec(line)?.[1] ?? this.listedInit
    const dated = PROGRAM_DATE.exec(line)
    if (dated != null) {
      const ms = Date.parse(dated[1])
      if (Number.isFinite(ms)) this.pendingPdt = ms
    }
    const duration = LISTED_DURATION.exec(line)
    if (duration != null) this.pendingSec = Number.parseFloat(duration[1])
    if (!LISTED_NAME.test(line)) return
    if (this.pendingSec != null) {
      const last = this.listed.at(-1)
      if (last != null && listedNumber(line) <= listedNumber(last.name))
        this.listedRising = false
      this.listed.push({
        name: line,
        init: this.listedInit,
        durationSec: this.pendingSec,
        ...(this.pendingPdt == null ? {} : { programDateMs: this.pendingPdt })
      })
      if (!this.partsSeen.has(this.listedInit)) {
        this.partsSeen.add(this.listedInit)
        this.parts.push({
          init: this.listedInit,
          name: line,
          durationSec: this.pendingSec
        })
      }
    }
    this.pendingSec = undefined
    this.pendingPdt = undefined
  }

  private addPublished(raw: string, text: string): void {
    if (text !== '') this.spaceAfterLastName = false
    if (raw.endsWith('\r')) this.irregular = true
    if (text === '#EXT-X-ENDLIST') {
      this.endBeforePiece = true
      return
    }
    if (text !== '' && !text.startsWith('#')) {
      if (!isSegmentName(text) || this.endBeforePiece) this.irregular = true
      else {
        const number = segmentNumber(text)
        if (number <= this.lastNumber) this.irregular = true
        this.lastNumber = number
      }
      this.pieceEnds.push(this.parsed)
      this.media = true
      this.spaceAfterLastName = raw !== raw.trimEnd()
    } else {
      if (MEDIA_TAG.test(text)) this.media = true
      if (!this.media) this.headerEnd = this.parsed
    }
  }

  /** Where `name` is first listed, among the first `count`. */
  private listedAt(name: string, count: number): number | undefined {
    if (this.listedRising) {
      // Rising numbers: a binary search by number.
      const number = listedNumber(name)
      let low = 0
      let high = count
      while (low < high) {
        const middle = (low + high) >> 1
        if (listedNumber(this.listed[middle].name) < number) low = middle + 1
        else high = middle
      }
      return low < count && this.listed[low].name === name ? low : undefined
    }
    this.listedFirst ??= { at: new Map(), through: 0 }
    const first = this.listedFirst
    for (; first.through < this.listed.length; first.through++) {
      const listed = this.listed[first.through].name
      if (!first.at.has(listed)) first.at.set(listed, first.through)
    }
    const at = first.at.get(name)
    return at != null && at < count ? at : undefined
  }

  view(complete: boolean): PlaylistView {
    const count = this.segments.length
    const listedCount = this.listed.length
    const text = this.text
    const { map, ended, headerEnd } = this
    // Copies, so the view stays as it was read; a recording has a few parts.
    const inits = [...this.inits]
    const parts = [...this.parts]
    const publishedExact =
      complete &&
      !this.irregular &&
      !this.spaceAfterLastName &&
      this.pieceEnds.length === count
    const endOf = (end: number): number =>
      end === 0 ? headerEnd : this.pieceEnds[end - 1]
    return {
      generation: this.generation,
      count,
      map,
      inits,
      parts,
      ended,
      segment: index => this.segments[index],
      startMs: index => this.startsMs[index],
      listedCount,
      listed: index => this.listed[index],
      listedAt: name => this.listedAt(name, listedCount),
      publishedExact,
      bodyText: end => text.slice(0, endOf(end)),
      bodyBetween: (from, to) => text.slice(endOf(from), endOf(to)),
      mediaPlaylist: () => ({
        ...(map == null ? {} : { map }),
        segments: this.segments.slice(0, count),
        ended
      }),
      text: () => text
    }
  }
}

/** A listed name's number: `seg000042.m4s` is 42. */
function listedNumber(name: string): number {
  return Number(name.slice(3, -4))
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
    const text = bytes.toString('utf8')
    const complete = text === '' || text.endsWith('\n')
    parse.addText(text)
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
    parse.addText(added.toString('utf8'))
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
