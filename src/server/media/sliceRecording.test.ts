import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { putObject } from './images'
import {
  pieceLooksRight,
  type SlicePiece,
  slicePlan,
  sliceSpaceObject
} from './sliceRecording'
import { OBJECTS_IN_FLIGHT } from './spacesVideo'

const ONE_MAP = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
  '#EXTINF:6.000000,',
  '#EXT-X-BYTERANGE:400@100',
  'video.mp4',
  '#EXTINF:6.000000,',
  '#EXT-X-BYTERANGE:300@500',
  'video.mp4',
  '#EXTINF:2.500000,',
  '#EXT-X-BYTERANGE:200',
  'video.mp4',
  '#EXT-X-ENDLIST',
  ''
].join('\n')

describe('slicePlan', function () {
  it('names an init and each segment by the playlist’s ranges', function () {
    const plan = slicePlan(ONE_MAP)
    expect(plan.media).equals('video.mp4')
    expect(plan.pieces).deep.equals([
      { name: 'init.mp4', kind: 'init', offset: 0, length: 100 },
      { name: 'seg000000.m4s', kind: 'segment', offset: 100, length: 400 },
      { name: 'seg000001.m4s', kind: 'segment', offset: 500, length: 300 },
      // Offsetless: carries on from the range before it.
      { name: 'seg000002.m4s', kind: 'segment', offset: 800, length: 200 }
    ])
    expect(plan.bytes).equals(1000)
  })

  it('lists the pieces in the same playlist, with no byte ranges', function () {
    const { playlist } = slicePlan(ONE_MAP)
    expect(playlist).does.not.contain('BYTERANGE')
    expect(playlist).does.not.contain('video.mp4')
    expect(playlist.split('\n')).deep.equals([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6.000000,',
      'seg000000.m4s',
      '#EXTINF:6.000000,',
      'seg000001.m4s',
      '#EXTINF:2.500000,',
      'seg000002.m4s',
      '#EXT-X-ENDLIST',
      ''
    ])
  })

  it('names a later configuration’s init after its first segment, and a repeated one once', function () {
    const lines = ['#EXTM3U', '#EXT-X-MAP:URI="video.mp4",BYTERANGE="10@0"']
    let at = 10
    for (let i = 0; i < 40; i++) {
      lines.push('#EXTINF:6.0,', `#EXT-X-BYTERANGE:10@${at}`, 'video.mp4')
      at += 10
    }
    lines.push(
      '#EXT-X-DISCONTINUITY',
      `#EXT-X-MAP:URI="video.mp4",BYTERANGE="20@${at}"`
    )
    const second = at
    at += 20
    lines.push('#EXTINF:6.0,', `#EXT-X-BYTERANGE:10@${at}`, 'video.mp4')
    at += 10
    // The same map again, as a player may be told before each segment.
    lines.push(`#EXT-X-MAP:URI="video.mp4",BYTERANGE="20@${second}"`)
    lines.push('#EXTINF:6.0,', `#EXT-X-BYTERANGE:10@${at}`, 'video.mp4')
    lines.push('#EXT-X-ENDLIST')
    const plan = slicePlan(lines.join('\n'))
    const inits = plan.pieces.filter(piece => piece.kind === 'init')
    expect(inits.map(piece => piece.name)).deep.equals([
      'init.mp4',
      'init000040.mp4'
    ])
    expect(plan.playlist).contains(
      '#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init000040.mp4"'
    )
    expect(plan.playlist.match(/init000040\.mp4/g)).length(2)
    expect(plan.pieces.filter(piece => piece.kind === 'segment')).length(42)
  })

  it('refuses what is not one file in ranges', function () {
    expect(() =>
      slicePlan(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg000000.m4s\n'
      )
    ).throws(/byte range/)
    expect(() =>
      slicePlan(ONE_MAP.replace('400@100\nvideo.mp4', '400@100\nother.mp4'))
    ).throws(/more than one media file/)
    expect(() => slicePlan(ONE_MAP.replace('300@500', '300@450'))).throws(
      /overlaps/
    )
    expect(() => slicePlan(ONE_MAP.replace('300@500', '300@600'))).throws(/gap/)
    expect(() => slicePlan('#EXTM3U\n#EXT-X-ENDLIST\n')).throws(
      /no byte ranges/
    )
  })
})

/** A box of `type` with `size` bytes of nothing in it. */
function box(type: string, size = 16): Buffer {
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32BE(size, 0)
  bytes.write(type, 4, 'latin1')
  return bytes
}

describe('a piece’s leading boxes', function () {
  const init: SlicePiece = {
    name: 'init.mp4',
    kind: 'init',
    offset: 0,
    length: 0
  }
  const segment: SlicePiece = {
    name: 'seg000000.m4s',
    kind: 'segment',
    offset: 0,
    length: 0
  }
  it('takes an init that is ftyp then moov, and a fragment that is moof', function () {
    expect(
      pieceLooksRight(init, Buffer.concat([box('ftyp'), box('moov')]))
    ).equals(true)
    expect(
      pieceLooksRight(segment, Buffer.concat([box('moof'), box('mdat')]))
    ).equals(true)
    expect(
      pieceLooksRight(
        segment,
        Buffer.concat([box('styp'), box('sidx'), box('moof'), box('mdat')])
      )
    ).equals(true)
  })
  it('refuses a piece cut in the wrong place', function () {
    expect(pieceLooksRight(init, box('moof'))).equals(false)
    expect(pieceLooksRight(init, box('ftyp'))).equals(false)
    expect(pieceLooksRight(segment, box('mdat'))).equals(false)
    expect(pieceLooksRight(segment, box('styp'))).equals(false)
  })
})

describe('sliceSpaceObject', function () {
  const space = {
    endpoint: 'https://sfo3.digitaloceanspaces.com',
    region: 'sfo3',
    bucket: 'teamstation',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    pathStyle: false,
    mediaBaseUrl: 'https://teamstation.sfo3.cdn.digitaloceanspaces.com'
  }
  const SECRET = '0123456789abcdef0123456789abcdef'
  /** The single file: an init, then 30 fragments. */
  const file = Buffer.concat([
    box('ftyp', 50),
    box('moov', 50),
    ...Array.from({ length: 30 }, () =>
      Buffer.concat([box('moof', 40), box('mdat', 60)])
    )
  ])
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
    ...Array.from({ length: 30 }, (_, i) => [
      '#EXTINF:6.0,',
      `#EXT-X-BYTERANGE:100@${100 + i * 100}`,
      'video.mp4'
    ]).flat(),
    '#EXT-X-ENDLIST'
  ].join('\n')
  const plan = slicePlan(playlist)

  function rig(
    change: (range: [number, number]) => Buffer | number | undefined = () =>
      undefined
  ): {
    fetch: typeof fetch
    put: typeof putObject
    gets: string[]
    puts: Array<Parameters<typeof putObject>[0]>
    most: () => number
  } {
    const gets: string[] = []
    const puts: Array<Parameters<typeof putObject>[0]> = []
    let inFlight = 0
    let most = 0
    return {
      gets,
      puts,
      most: () => most,
      fetch: (async (url: string, init?: RequestInit) => {
        gets.push(url)
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise(resolve => setTimeout(resolve, 3))
        inFlight--
        const header = (init?.headers as Record<string, string>).range
        const [, from, to] = /bytes=(\d+)-(\d+)/.exec(header)!.map(Number)
        const changed = change([from, to])
        if (typeof changed === 'number')
          return new Response('', { status: changed })
        return new Response(changed ?? file.subarray(from, to + 1), {
          status: 206
        })
      }) as unknown as typeof fetch,
      put: async options => {
        puts.push(options)
      }
    }
  }

  it('copies every range from the origin, eight at a time, to its own object', async function () {
    const r = rig()
    await sliceSpaceObject({
      space,
      source: { id: 'vid_one', spaceSecret: null },
      target: { id: 'vid_one', spaceSecret: SECRET },
      plan,
      objectBytes: file.length,
      fetch: r.fetch,
      put: r.put
    })
    expect(r.gets).length(31)
    for (const url of r.gets) {
      // The origin, signed; never the CDN.
      expect(
        url.startsWith(
          'https://teamstation.sfo3.digitaloceanspaces.com/videos/vid_one/video.mp4?'
        )
      ).equals(true)
      expect(url).contains('X-Amz-Signature=')
    }
    expect(r.most()).equals(OBJECTS_IN_FLIGHT)
    const byName = new Map(
      r.puts.map(put => [put.key.split('/').at(-1) ?? '', put])
    )
    const order = (a: string, b: string): number => a.localeCompare(b)
    expect([...byName.keys()].sort(order)).deep.equals(
      plan.pieces.map(piece => piece.name).sort(order)
    )
    const init = byName.get('init.mp4')!
    expect(init.key).equals(`videos/vid_one-${SECRET}/init.mp4`)
    expect([init.acl, init.cacheControl, init.contentType]).deep.equals([
      'public-read',
      'no-cache',
      'video/mp4'
    ])
    const segment = byName.get('seg000029.m4s')!
    expect([
      segment.acl,
      segment.cacheControl,
      segment.contentType
    ]).deep.equals(['public-read', 'public, max-age=600', 'video/iso.segment'])
    expect(segment.body.equals(file.subarray(3000, 3100))).equals(true)
  })

  it('refuses ranges that do not cover the file', async function () {
    const r = rig()
    let thrown: unknown
    await sliceSpaceObject({
      space,
      source: { id: 'vid_one', spaceSecret: null },
      target: { id: 'vid_one', spaceSecret: SECRET },
      plan,
      objectBytes: file.length + 1,
      fetch: r.fetch,
      put: r.put
    }).catch((error: unknown) => (thrown = error))
    expect(String(thrown)).match(/cover/)
    expect(r.gets).length(0)
  })

  it('fails on a short read, a piece cut in the wrong place, or a refusal', async function () {
    for (const [change, message] of [
      [
        ([from]: [number, number]) =>
          from === 1000 ? file.subarray(1000, 1050) : undefined,
        /came back 50 bytes/
      ],
      [
        ([from]: [number, number]) =>
          from === 1000 ? Buffer.concat([box('mdat', 100)]) : undefined,
        /not a whole segment/
      ],
      [
        ([from]: [number, number]) => (from === 1000 ? 403 : undefined),
        /answered 403/
      ]
    ] as const) {
      const r = rig(change)
      let thrown: unknown
      await sliceSpaceObject({
        space,
        source: { id: 'vid_one', spaceSecret: SECRET },
        target: {
          id: 'vid_one',
          spaceSecret: 'fedcba9876543210fedcba9876543210'
        },
        plan,
        objectBytes: file.length,
        fetch: r.fetch,
        put: r.put
      }).catch((error: unknown) => (thrown = error))
      expect(String(thrown)).match(message)
      expect(String(thrown)).does.not.contain(SECRET)
    }
  })
})
