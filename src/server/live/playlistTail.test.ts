import { expect } from 'chai'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'fs'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseMediaPlaylist } from '../media/wallClockScan'
import { publishedPlaylist, segmentEndsMs } from './originPublish'
import {
  HELD_PLAYLISTS,
  PlaylistTail,
  playlistTail,
  type PlaylistView,
  type TailFiles,
  WINDOW_BYTES
} from './playlistTail'
import { listedSegments } from './segmentClock'

const HEADER =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
const name = (n: number): string => `seg${String(n).padStart(6, '0')}.m4s`

/** One piece as FFmpeg writes it, with a program date and now and then a break. */
function piece(n: number): string {
  const at = new Date(Date.UTC(2026, 10, 5, 12) + n * 4000).toISOString()
  const length = n % 7 === 3 ? '3.966667' : '4.000000'
  return (
    (n % 50 === 49 ? '#EXT-X-DISCONTINUITY\n' : '') +
    `#EXTINF:${length},\n#EXT-X-PROGRAM-DATE-TIME:${at}\n${name(n)}\n`
  )
}
const pieces = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, n) => piece(from + n)).join('')

/** Node's calls, counted. */
function countingFiles(): TailFiles & {
  calls: Record<string, number>
  reset: () => void
} {
  const calls: Record<string, number> = {}
  const count = (call: string): void => {
    calls[call] = (calls[call] ?? 0) + 1
  }
  return {
    calls,
    reset: () => {
      for (const call of Object.keys(calls)) calls[call] = 0
    },
    readFileSync: path => {
      count('readFileSync')
      return readFileSync(path)
    },
    openSync: (path, flags) => {
      count('openSync')
      return openSync(path, flags)
    },
    fstatSync: fd => {
      count('fstatSync')
      return fstatSync(fd)
    },
    readSync: (fd, buffer, offset, length, position) => {
      count('readSync')
      return readSync(fd, buffer, offset, length, position)
    },
    closeSync: fd => {
      count('closeSync')
      closeSync(fd)
    }
  }
}

/** Everything a view holds, as the whole-text parses give it. */
function expectParsedAs(view: PlaylistView, text: string): void {
  expect(view.text()).equals(text)
  expect(view.mediaPlaylist()).deep.equals(parseMediaPlaylist(text))
  const media = parseMediaPlaylist(text).segments
  expect(view.count).equals(media.length)
  expect(
    Array.from({ length: view.count }, (_, i) => view.segment(i))
  ).deep.equals(media)
  let start = 0
  for (const [index, segment] of media.entries()) {
    expect(view.startMs(index)).equals(start)
    start += segment.durationSec * 1000
  }
  expect(view.startMs(media.length)).equals(start)
  expect(
    Array.from({ length: view.count }, (_, i) => view.endMs(i))
  ).deep.equals(segmentEndsMs(text))
  const listed = listedSegments(text)
  expect(view.listedCount).equals(listed.length)
  expect(
    Array.from({ length: view.listedCount }, (_, i) => view.listed(i))
  ).deep.equals(listed)
  for (const segment of listed)
    expect(view.listedAt(segment.name)).equals(
      listed.findIndex(other => other.name === segment.name)
    )
  expect(view.listedAt('seg999999.m4s')).equals(undefined)
  // Each part's init segment, as the publisher stores and the master names them.
  const parsed = parseMediaPlaylist(text)
  expect(view.inits).deep.equals([
    ...new Set([
      ...(parsed.map == null ? [] : [parsed.map.uri]),
      ...parsed.segments.flatMap(segment =>
        segment.map == null ? [] : [segment.map.uri]
      )
    ])
  ])
  const parts = new Map<
    string,
    { init: string; name: string; durationSec: number }
  >()
  for (const { name, init, durationSec } of listed)
    if (!parts.has(init)) parts.set(init, { init, name, durationSec })
  expect(view.parts).deep.equals([...parts.values()])
  if (view.publishedExact) {
    // The body of each acknowledged prefix, and what each piece adds to it.
    const names = media.map(segment => segment.uri)
    for (const end of new Set([0, 1, view.count >> 1, view.count - 1])) {
      if (end < 0 || end >= view.count) continue
      const prefix = new Set(names.slice(0, end))
      const body = view.bodyText(end)
      expect(body === '' ? '\n' : body).equals(
        publishedPlaylist(text, prefix, new Set())
      )
      expect(view.bodyText(end) + view.bodyBetween(end, view.count)).equals(
        view.bodyText(view.count)
      )
    }
    const ended = view.ended ? '#EXT-X-ENDLIST\n' : ''
    expect(view.bodyText(view.count) + ended).equals(
      publishedPlaylist(text, new Set(names), new Set())
    )
  }
}

describe('reading a live playlist as it grows', function () {
  let dir: string
  let path: string
  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'tsPlaylistTail-'))
    path = join(dir, 'master.m3u8')
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses as the whole text does after every one of many appends, reading only what each added', function () {
    const files = countingFiles()
    const tail = new PlaylistTail(path, files)
    expect(tail.read()).equals(undefined)
    let text = HEADER
    writeFileSync(path, text)
    expectParsedAs(tail.read()!, text)
    const generation = tail.read()!.generation
    for (let n = 0; n < 300; n++) {
      // As FFmpeg does: the whole file written again, one piece longer.
      text += piece(n)
      if (n === 150) text += '#EXT-X-ENDLIST\n'
      writeFileSync(path, text)
      files.reset()
      const before = tail.bytesRead
      const view = tail.read()!
      expect(view.generation).equals(generation)
      expect(files.calls.readFileSync ?? 0).equals(0)
      // The two windows, and the piece.
      expect(tail.bytesRead - before).equals(
        Math.min(WINDOW_BYTES, text.length) +
          Math.min(WINDOW_BYTES, text.length - piece(n).length) +
          piece(n).length +
          (n === 150 ? '#EXT-X-ENDLIST\n'.length : 0)
      )
      if (n % 25 === 0 || n === 151) expectParsedAs(view, text)
    }
    expectParsedAs(tail.read()!, text)
    // Nothing added: the same view.
    expect(tail.read()).equals(tail.read())
  })

  it('follows a recording a differently configured camera continued, part by part', function () {
    const tail = new PlaylistTail(path)
    let text = HEADER + pieces(0, 30)
    writeFileSync(path, text)
    const first = tail.read()!
    expectParsedAs(first, text)
    expect(first.inits).deep.equals(['init.mp4'])
    // The ingest carries the next writer's segments on behind its own map.
    for (const [at, init] of [
      [30, 'init000030.mp4'],
      [60, 'init000060.mp4']
    ] as const) {
      text +=
        `#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="${init}"\n` + pieces(at, at + 30)
      writeFileSync(path, text)
      expectParsedAs(tail.read()!, text)
    }
    const view = tail.read()!
    expect(view.generation).equals(first.generation)
    expect(view.inits).deep.equals([
      'init.mp4',
      'init000030.mp4',
      'init000060.mp4'
    ])
    expect(view.parts.map(part => [part.init, part.name])).deep.equals([
      ['init.mp4', name(0)],
      ['init000030.mp4', name(30)],
      ['init000060.mp4', name(60)]
    ])
    expect(view.segment(45).map?.uri).equals('init000030.mp4')
    expect(view.segment(10).map).equals(undefined)
    // The earlier view is as it was.
    expect(first.inits).deep.equals(['init.mp4'])
    expect(first.parts).length(1)
  })

  it('keeps each view as it was when it was read while the playlist grows', function () {
    writeFileSync(path, HEADER + pieces(0, 3))
    const tail = new PlaylistTail(path)
    const early = tail.read()!
    writeFileSync(path, HEADER + pieces(0, 9))
    const late = tail.read()!
    expect(early.count).equals(3)
    expect(early.listedCount).equals(3)
    expect(early.listedAt(name(5))).equals(undefined)
    expect(early.bodyText(3)).equals(HEADER + pieces(0, 3))
    expect(early.mediaPlaylist().segments).length(3)
    expect(early.text()).equals(HEADER + pieces(0, 3))
    expect(late.count).equals(9)
    expect(late.listedAt(name(5))).equals(5)
    expect(late.bodyBetween(3, 9)).equals(pieces(3, 9))
  })

  it('reads it all again when it was rewritten, shrank, or a reconnect changed its header', function () {
    const files = countingFiles()
    const tail = new PlaylistTail(path, files)
    let text = HEADER + pieces(0, 40)
    writeFileSync(path, text)
    let generation = tail.read()!.generation
    const reread = (next: string): void => {
      writeFileSync(path, next)
      files.reset()
      const view = tail.read()!
      expect(files.calls.readFileSync).equals(1)
      expect(view.generation).not.equals(generation)
      generation = view.generation
      expectParsedAs(view, next)
      text = next
    }
    // The last piece's length settled, in place: the same size.
    reread(
      text.replace(
        /#EXTINF:4\.000000,(\n[^\n]*\nseg000039)/,
        '#EXTINF:3.999999,$1'
      )
    )
    expect(text.length).equals((HEADER + pieces(0, 40)).length)
    // Closed, then reopened: the end tag comes off and the playlist shrinks.
    text += '#EXT-X-ENDLIST\n'
    writeFileSync(path, text)
    expect(tail.read()!.ended).equals(true)
    reread(text.replace('#EXT-X-ENDLIST\n', ''))
    expect(tail.read()!.ended).equals(false)
    // A reconnect: `append_list` writes its own header over the old one and
    // the pieces after a discontinuity.
    reread(
      text.replace('#EXT-X-TARGETDURATION:4', '#EXT-X-TARGETDURATION:5') +
        '#EXT-X-DISCONTINUITY\n' +
        pieces(40, 42)
    )
    expect(tail.read()!.segment(40).discontinuity).equals(true)
    // A rewrite that changes the old end, with more after it.
    reread(text.replace(name(41), name(43)) + pieces(42, 43))
    // Gone, then back.
    rmSync(path)
    expect(tail.read()).equals(undefined)
    reread(HEADER + pieces(0, 2))
  })

  it('parses a playlist caught part way through a write whole, each time, until it ends a line', function () {
    const files = countingFiles()
    const tail = new PlaylistTail(path, files)
    const text = HEADER + pieces(0, 5)
    writeFileSync(path, text)
    tail.read()
    const partial = text + '#EXTINF:4.000000,\nseg000005'
    writeFileSync(path, partial)
    files.reset()
    expectParsedAs(tail.read()!, partial)
    expect(files.calls.readFileSync).equals(1)
    expectParsedAs(tail.read()!, partial)
    expect(files.calls.readFileSync).equals(2)
    writeFileSync(path, partial + '.m4s\n')
    expectParsedAs(tail.read()!, partial + '.m4s\n')
    expect(files.calls.readFileSync).equals(3)
    files.reset()
    writeFileSync(path, partial + '.m4s\n' + piece(6))
    expectParsedAs(tail.read()!, partial + '.m4s\n' + piece(6))
    expect(files.calls.readFileSync).equals(0)
  })

  it('says when the published playlist would not keep one piece per segment as written', function () {
    const tail = new PlaylistTail(path)
    const check = (text: string, exact: boolean): void => {
      writeFileSync(path, text)
      const view = tail.read()!
      expectParsedAs(view, text)
      expect(view.publishedExact).equals(exact)
    }
    check(HEADER + pieces(0, 3), true)
    // One file and byte ranges, as a remux writes them.
    check(
      '#EXTM3U\n#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"\n' +
        '#EXTINF:4,\n#EXT-X-BYTERANGE:1000@800\nvideo.mp4\n' +
        '#EXTINF:4,\n#EXT-X-BYTERANGE:1200\nvideo.mp4\n',
      false
    )
    // Carriage returns, which the published body leaves out.
    check(
      HEADER.replaceAll('\n', '\r\n') + pieces(0, 3).replaceAll('\n', '\r\n'),
      false
    )
    // An end tag with a piece after it, which the published body leaves out.
    check(HEADER + pieces(0, 2) + '#EXT-X-ENDLIST\n' + piece(2), false)
    check(HEADER + pieces(0, 3) + '\n\n', true)
    // A name with space after it, last: the trimmed end would cut it.
    check(HEADER + pieces(0, 2) + '#EXTINF:4,\nseg000002.m4s  \n', false)
    check(
      HEADER + pieces(0, 2) + '#EXTINF:4,\nseg000002.m4s  \n' + piece(3),
      true
    )
    check(HEADER + pieces(0, 2) + piece(1), false)
    check(HEADER + pieces(0, 2) + '#EXTINF:4,\nother.ts\n', false)
    check(HEADER + pieces(0, 2) + 'seg000002.m4s\n', false)
  })

  it('throws any failure to read but a missing file', function () {
    mkdirSync(path)
    expect(() => new PlaylistTail(path).read()).throws(/EISDIR/)
  })

  it('shares one reader per playlist, and holds only so many', function () {
    expect(playlistTail(path)).equals(
      playlistTail(join(dir, '.', 'master.m3u8'))
    )
    const first = playlistTail(path)
    for (let n = 0; n < HELD_PLAYLISTS; n++)
      playlistTail(join(dir, `${n}.m3u8`))
    expect(playlistTail(path)).not.equals(first)
  })
})
