import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  firstMarkers,
  parsePlaylist,
  readMarkerGray,
  wallAtPosition
} from './playlistClock'
import { markerGeometry } from './readMarker'

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-MEDIA-SEQUENCE:7',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-27T10:00:00.000Z',
  '#EXTINF:4.000,',
  'seg000007.m4s',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:2.5,',
  'seg000008.m4s',
  '#EXT-X-ENDLIST',
  ''
].join('\n')

/** A grey picture with the marker of `value` drawn as the broadcaster draws it. */
function picture(
  value: number,
  width: number,
  height: number,
  options: { sentinel?: boolean; strip?: number } = {}
): Uint8Array {
  const pixels = new Uint8Array(width * height)
  const g = markerGeometry(height)
  const fill = (x0: number, y0: number, side: number, level: number): void => {
    for (let y = y0; y < y0 + side; y++)
      for (let x = x0; x < x0 + side; x++) pixels[y * width + x] = level
  }
  for (let bit = 0; bit < g.bits; bit++) {
    if ((value / 2 ** bit) % 2 >= 1)
      fill(g.originX + bit * g.stride, g.originY, g.cell, 255)
  }
  if (options.sentinel !== false)
    fill(g.originX + g.sentinelSlot * g.stride, g.originY, g.cell, 255)
  if (options.strip != null)
    fill(g.originX, g.originY + g.cell + 2, g.cell, options.strip)
  return pixels
}

describe('the playlist clock', function () {
  it('reads a media playlist as a player does', function () {
    const { mediaSequence, ended, segments } = parsePlaylist(PLAYLIST)
    expect(mediaSequence).equals(7)
    expect(ended).equals(true)
    expect(segments).deep.equals([
      {
        uri: 'seg000007.m4s',
        sequence: 7,
        durationSec: 4,
        startSec: 0,
        discontinuity: false,
        programDateTime: Date.parse('2026-11-27T10:00:00.000Z')
      },
      {
        uri: 'seg000008.m4s',
        sequence: 8,
        durationSec: 2.5,
        startSec: 4,
        discontinuity: true,
        programDateTime: null
      }
    ])
    expect(parsePlaylist('#EXTM3U\nstray.m4s\n').segments).deep.equals([])
  })

  it('reads the burned marker off a grey picture, or nothing when it is covered', function () {
    const g = markerGeometry(720)
    expect(readMarkerGray(picture(0x12345678, 1280, 720), 1280, g)).equals(
      0x12345678
    )
    expect(
      readMarkerGray(picture(5, 1280, 720, { sentinel: false }), 1280, g)
    ).equals(null)
    expect(
      readMarkerGray(picture(5, 1280, 720, { strip: 200 }), 1280, g)
    ).equals(null)
  })

  it('puts a picture at a position from its segment’s first frame', function () {
    const { segments } = parsePlaylist(PLAYLIST)
    const markers = [1000, null]
    expect(wallAtPosition(segments, markers, 1.5)).equals(2500)
    expect(wallAtPosition(segments, markers, 5)).equals(null)
    expect(wallAtPosition(segments, markers, 99)).equals(null)
    expect(wallAtPosition(segments, markers, -1)).equals(null)
  })

  it('decodes each segment behind the init segment, and keeps a null for one it cannot read', async function () {
    const scratch = mkdtempSync(join(tmpdir(), 'playlist-clock-'))
    try {
      const { segments } = parsePlaylist(PLAYLIST)
      const joined: string[] = []
      const markers = await firstMarkers({
        segments,
        nearMs: Date.parse('2026-11-27T10:00:00.000Z'),
        init: Buffer.from('init|'),
        read: async uri => Buffer.from(uri),
        decode: async file => {
          const text = readFileSync(file, 'utf8')
          joined.push(text)
          return text.endsWith('7.m4s')
            ? picture(
                Date.parse('2026-11-27T10:00:01.000Z') % 2 ** 32,
                1280,
                720
              )
            : null
        },
        scratch,
        size: { width: 1280, height: 720 }
      })
      expect(joined).deep.equals(['init|seg000007.m4s', 'init|seg000008.m4s'])
      expect(markers).deep.equals([
        Date.parse('2026-11-27T10:00:01.000Z'),
        null
      ])
      const short = await firstMarkers({
        segments: segments.slice(0, 1),
        nearMs: 0,
        init: Buffer.from(''),
        read: async () => Buffer.from(''),
        decode: async () => new Uint8Array(4),
        scratch
      })
      expect(short).deep.equals([null])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
