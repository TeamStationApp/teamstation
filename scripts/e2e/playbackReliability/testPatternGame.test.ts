import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'

import { accountFrom, nodePasswordKdf, passwordOf } from './session'
import {
  type AngleShape,
  compareShapes,
  encodeArgs,
  gameSql,
  type Io,
  main,
  median,
  parsePair,
  playlistShape,
  streamShape,
  structureSql,
  videosSql,
  withoutKeys
} from './testPatternGame'

const USER = 'usr_1111111111111111111112'

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MAP:URI="https://media.example.test/v/video.mp4?sig=1"',
  '#EXTINF:6.000000,',
  '#EXT-X-BYTERANGE:3000@1400',
  'https://media.example.test/v/video.mp4?sig=1',
  '#EXTINF:6.000000,',
  '#EXT-X-BYTERANGE:3200@4400',
  'https://media.example.test/v/video.mp4?sig=1',
  '#EXTINF:2.300000,',
  '#EXT-X-BYTERANGE:1100@7600',
  'https://media.example.test/v/video.mp4?sig=1',
  '#EXT-X-ENDLIST'
].join('\n')

function shape(
  overrides: Partial<AngleShape['stream']> = {},
  sizes = [3000, 3200, 1100]
): AngleShape {
  return {
    playlist: {
      segments: sizes.length,
      durationSec: 14.3,
      sizes,
      headBytes: 4400,
      firstUrl: 'u'
    },
    stream: { codecTag: 'hvc1', fps: 60, keyframeSec: 2, ...overrides }
  }
}

/** An Io whose server and tools are fakes, recording what was printed. */
function fakeIo(
  routes: Record<string, (init?: RequestInit) => Response>,
  run: Io['run'],
  env: Record<string, string | undefined> = {}
): Io & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    log: line => {
      lines.push(line)
    },
    run,
    env,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const route = Object.keys(routes).find(key => url.includes(key))
      if (route == null) return new Response('not found', { status: 404 })
      return routes[route](init)
    }
  }
}

describe('playback probe: test-pattern game', function () {
  this.timeout(60000)
  let dir: string

  before(function () {
    dir = mkdtempSync(join(tmpdir(), 'pbr-pattern-'))
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('encodes the pattern the uploads are matched to, with the counter where the reader looks', function () {
    const args = encodeArgs({
      label: "1st: o'clock",
      startMs: Date.parse('2026-10-26T17:15:30.926Z'),
      durationSec: 5630.3,
      out: '/Users/dev/out.mp4',
      fontfile: '/Users/dev/font.ttc'
    })
    const text = args.join(' ')
    assert.match(text, /testsrc2=size=1920x1080:rate=60/)
    assert.match(text, /-t 5630\.3 /)
    assert.match(text, /-tag:v hvc1/)
    assert.match(text, /-g 120 /)
    assert.match(text, /drawbox=x=iw\*0\.3:y=ih\*0\.56:w=iw\*0\.4:h=ih\*0\.15/)
    assert.match(text, /%\{eif\\:n\\:d\\:7\}/)
    assert.match(text, /gmtime\\:1793034930\.926\\:/)
    assert.match(text, /text='1st\\: o'clock'/)
    assert.equal(args[args.length - 1], '/Users/dev/out.mp4')
  })

  it('makes a real, readable test pattern', function () {
    const out = join(dir, 'pattern.mp4')
    const args = encodeArgs({
      label: 'Home',
      startMs: 0,
      durationSec: 1,
      out,
      fontfile: '/System/Library/Fonts/Menlo.ttc'
    }).map(arg => (arg === 'hevc_videotoolbox' ? 'libx265' : arg))
    execFileSync(
      'ffmpeg',
      args.filter(
        (arg, index, all) =>
          !(arg === '-profile:v' || all[index - 1] === '-profile:v')
      ),
      { stdio: 'ignore' }
    )
    const probe = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_tag_string,r_frame_rate',
        '-of',
        'csv=p=0',
        out
      ],
      { encoding: 'utf8' }
    )
    assert.match(probe, /hvc1,60\/1/)
  })

  it('moves the game, its plays, its log and its replaced recording by the shift', function () {
    const game = gameSql('gam_source', "gam_n'ew", 86400000)
    assert.match(game, /'id', 'gam_n''ew'/)
    assert.match(game, /g\.start_at \+ interval '86400000 milliseconds'/)
    assert.match(game, /where g\.id = 'gam_source';/)
    assert.throws(() => gameSql('a', 'b', 1.5), /whole milliseconds/)
    const videos = videosSql([{ video: 'vid_tp', source: 'vid_up' }], 86400000)
    assert.match(
      videos,
      /start_at = s\.start_at \+ interval '86400000 milliseconds'/
    )
    assert.match(videos, /s\.id = 'vid_up' and v\.id = 'vid_tp'/)
    const structure = structureSql({
      source: 'gam_source',
      game: 'gam_tp',
      shiftMs: 1000,
      sourceLive: 'vid_live',
      live: 'vid_tplive',
      primary: 'vid_tp'
    })
    assert.match(structure, /from scoreboard_log where game_id = 'gam_source'/)
    assert.match(structure, /'replaced_by', 'vid_tp'/)
    assert.match(
      structure,
      /select 'vid_tplive', media_ms, wall \+ interval '1000 milliseconds'/
    )
    assert.match(
      structure,
      /'evt_' \|\| substr\(md5\(e\.id \|\| 'gam_tp'\), 1, 16\)/
    )
  })

  it('reads pairs and refuses half a pair', function () {
    assert.deepEqual(parsePair('vid_a=vid_b'), {
      video: 'vid_a',
      source: 'vid_b'
    })
    assert.throws(() => parsePair('vid_a'), /--pair wants/)
    assert.throws(() => parsePair('=vid_b'), /--pair wants/)
  })

  it('reads a playlist and a stream head', function () {
    const playlist = playlistShape(PLAYLIST)
    assert.equal(playlist.segments, 3)
    assert.ok(Math.abs(playlist.durationSec - 14.3) < 1e-9)
    assert.deepEqual(playlist.sizes, [3000, 3200, 1100])
    assert.equal(playlist.headBytes, 4400)
    assert.equal(
      playlist.firstUrl,
      'https://media.example.test/v/video.mp4?sig=1'
    )
    assert.equal(playlistShape('#EXTM3U').firstUrl, null)
    assert.deepEqual(
      streamShape(
        '{"streams":[{"codec_tag_string":"hvc1","r_frame_rate":"60/1"}]}',
        [0.044, 2.044, 4.044, 5.994, 8.044]
      ),
      { codecTag: 'hvc1', fps: 60, keyframeSec: 2 }
    )
    assert.deepEqual(streamShape('{}', []), {
      codecTag: '',
      fps: 0,
      keyframeSec: null
    })
    assert.equal(median([]), 0)
    assert.equal(median([4, 1, 3, 2]), 2.5)
  })

  it('finds every way an angle differs from its upload', function () {
    assert.deepEqual(compareShapes(shape(), shape()), [])
    const off = compareShapes(
      {
        ...shape({ codecTag: 'hev1', fps: 30, keyframeSec: 1 }, [9000, 9000]),
        playlist: {
          ...shape().playlist,
          segments: 2,
          durationSec: 20,
          sizes: [9000, 9000]
        }
      },
      shape()
    )
    assert.deepEqual(off, [
      'codec hev1 ≠ hvc1',
      '30 fps ≠ 60 fps',
      'keyframes every 1 s ≠ 2 s',
      '2 segments ≠ 3',
      '20.0 s ≠ 14.3 s',
      'median segment 9000 bytes is not within 15 % of 3000'
    ])
  })

  it('prints the SQL for each command and refuses an unknown one', async function () {
    const io = fakeIo({}, async () => '')
    assert.equal(
      await main(
        ['game-sql', '--source', 'gam_s', '--game', 'gam_t', '--shift-ms', '5'],
        io
      ),
      0
    )
    assert.equal(
      await main(
        [
          'videos-sql',
          '--shift-ms',
          '5',
          '--pair',
          'vid_a=vid_b',
          '--pair',
          'vid_c=vid_d'
        ],
        io
      ),
      0
    )
    assert.equal(
      await main(
        [
          'structure-sql',
          '--source',
          'gam_s',
          '--game',
          'gam_t',
          '--shift-ms',
          '5',
          '--source-live',
          'vid_l',
          '--live',
          'vid_m',
          '--primary',
          'vid_a'
        ],
        io
      ),
      0
    )
    assert.match(io.lines[0], /insert into games/)
    assert.match(io.lines[1], /v\.id = 'vid_c'/)
    assert.match(io.lines[2], /insert into video_wall_anchors/)
    await assert.rejects(main(['nonsense'], io), /commands: encode/)
    await assert.rejects(
      main(['game-sql', '--source', 'gam_s'], io),
      /--game is required/
    )
  })

  it('encodes each angle, or one, through the run it is given', async function () {
    const runs: string[][] = []
    const io = fakeIo(
      {},
      async (program, args) => {
        runs.push([program, ...args])
        return ''
      },
      {
        TS_PATTERN_FONT: '/Users/dev/font.ttc',
        FFMPEG_PATH: '/Users/dev/ffmpeg'
      }
    )
    assert.equal(
      await main(
        [
          'encode',
          '--out',
          '/Users/dev/out',
          '--start',
          '2026-10-26T17:15:30.926Z'
        ],
        io
      ),
      0
    )
    assert.equal(runs.length, 4)
    assert.equal(runs[0][0], '/Users/dev/ffmpeg')
    assert.equal(runs[3][runs[3].length - 1], '/Users/dev/out/3rd.mp4')
    await main(
      [
        'encode',
        '--out',
        '/Users/dev/out',
        '--start',
        '2026-10-26T17:15:30Z',
        '--only',
        'Home',
        '--duration',
        '2'
      ],
      io
    )
    assert.equal(runs.length, 5)
    assert.ok(runs[4].includes('2'))
    await assert.rejects(
      main(['encode', '--out', 'x', '--start', 'soon'], io),
      /not a time/
    )
  })

  it('sends one angle live, at its own pace, as FLV HEVC', async function () {
    const runs: string[][] = []
    const io = fakeIo({}, async (program, args) => {
      runs.push([program, ...args])
      return ''
    })
    assert.equal(
      await main(
        [
          'live',
          '--label',
          '1st',
          '--url',
          'rtmp://seat.example.test:2002/live/key'
        ],
        io
      ),
      0
    )
    const text = runs[0].join(' ')
    assert.match(text, /-re -f lavfi/)
    assert.match(text, /-realtime 1/)
    assert.match(text, /-t 3600 /)
    assert.doesNotMatch(text, /hvc1/)
    assert.match(text, /-f flv rtmp:\/\/seat\.example\.test:2002\/live\/key$/)
    await assert.rejects(main(['live', '--label', 'Home'], io), /--url/)
    // A sender that fails says which angle, and never its key.
    const failing = fakeIo({}, async (_program, args) => {
      throw new Error(
        `Command failed: ffmpeg ${args.join(' ')}\nConnection refused`
      )
    })
    await assert.rejects(
      main(
        ['live', '--label', '1st', '--url', 'rtmp://seat/live/secretkey'],
        failing
      ),
      (error: Error) =>
        /^1st: .*Connection refused/s.test(error.message) &&
        !error.message.includes('secretkey')
    )
    assert.equal(withoutKeys('to rtmps://a/b/c now'), 'to rtmp://… now')
  })

  it('sends the first angles live on the game, reusing a camera it already holds', async function () {
    const stream = (id: string, label: string, url?: string): object => ({
      id,
      gameId: 'gam_live',
      userId: USER,
      ownerName: 'Mike Trout',
      slot: 1,
      label,
      keyPrefix: 'abcd',
      state: 'waiting',
      opensAt: '2026-10-27T00:00:00Z',
      closesAt: null,
      ...(url == null ? {} : { url })
    })
    const added: string[] = []
    const routes: Record<string, (init?: RequestInit) => Response> = {
      '/auth/password/parameters': () =>
        Response.json({
          algorithm: 'argon2id',
          version: 19,
          memoryKiB: 19456,
          iterations: 2,
          parallelism: 1,
          hashLength: 32,
          salt: '00'.repeat(16)
        }),
      '/auth/password': () =>
        Response.json({
          token: 'session-token',
          expiresAt: '2026-11-01T00:00:00Z',
          user: { id: USER, displayName: 'Mike Trout', isAdmin: false }
        }),
      '/live-streams/str_held/reveal': () =>
        Response.json(stream('str_held', 'Primary', 'rtmp://seat/live/k1')),
      '/live-streams': init => {
        if (init?.method === 'POST') {
          const { label } = JSON.parse(init.body as string) as {
            label: string
          }
          added.push(label)
          return Response.json(
            stream(
              'str_new',
              label,
              label === 'Home' ? 'rtmp://seat/live/k2' : undefined
            )
          )
        }
        return Response.json({
          gameId: 'gam_live',
          mine: [stream('str_held', 'Primary')],
          others: [],
          canAdd: 3,
          maxCameras: 4
        })
      }
    }
    const sent: string[] = []
    const io = fakeIo(
      routes,
      async (program, args) => {
        if (program === 'op-scotty') {
          return JSON.stringify({
            fields: [{ purpose: 'PASSWORD', value: 'not-a-real-password' }]
          })
        }
        sent.push(args[args.length - 1])
        return ''
      },
      { TS_ACCOUNT_EMAIL: 'player@example.test', TS_ACCOUNT_ITEM: 'item' }
    )
    const app = ['--app', 'https://seat.example.test', '--game', 'gam_live']
    assert.equal(await main(['live-game', ...app, '--count', '2'], io), 0)
    assert.deepEqual(added, ['Home'])
    assert.deepEqual(sent, ['rtmp://seat/live/k1', 'rtmp://seat/live/k2'])
    assert.deepEqual(io.lines, ['sending Primary, Home to gam_live'])
    assert.ok(!io.lines.join('\n').includes('rtmp://'))
    // A camera the server would not give a URL for stops the run.
    await assert.rejects(
      main(['live-game', ...app, '--count', '3'], io),
      /no URL for 1st/
    )
  })

  it('verifies the angles against their uploads and the game against home, signed in', async function () {
    const media = PLAYLIST
    const routes: Record<string, (init?: RequestInit) => Response> = {
      '/auth/password/parameters': () =>
        Response.json({
          algorithm: 'argon2id',
          version: 19,
          memoryKiB: 19456,
          iterations: 2,
          parallelism: 1,
          hashLength: 32,
          salt: '00'.repeat(16)
        }),
      '/auth/password': () =>
        Response.json({
          token: 'session-token',
          expiresAt: '2026-11-01T00:00:00Z',
          user: { id: USER, displayName: 'Mike Trout', isAdmin: false }
        }),
      '/playback': () =>
        Response.json({
          videoId: 'vid_tp',
          storage: 'spaces',
          url: 'https://media.example.test/v/master.m3u8',
          expiresAt: null,
          durationSec: 14.3,
          unavailable: false
        }),
      'master.m3u8': () =>
        new Response('#EXTM3U\nhttps://media.example.test/v/video.m3u8\n'),
      'video.m3u8': () => new Response(media),
      'video.mp4': init => {
        assert.equal(new Headers(init?.headers).get('Range'), 'bytes=0-13199')
        return new Response(new Uint8Array(16))
      },
      '/events?played=1': () => Response.json([])
    }
    const programs: string[] = []
    const io = fakeIo(
      routes,
      async (program, args) => {
        programs.push(program)
        if (program === 'op-scotty') {
          return JSON.stringify({
            fields: [{ purpose: 'PASSWORD', value: 'not-a-real-password' }]
          })
        }
        return args.includes('-skip_frame')
          ? '0.044,\n2.044,\n4.044,\n\n'
          : '{"streams":[{"codec_tag_string":"hvc1","r_frame_rate":"60/1"}]}'
      },
      { TS_ACCOUNT_EMAIL: 'player@example.test', TS_ACCOUNT_ITEM: 'item' }
    )
    const code = await main(
      [
        'verify',
        '--app',
        'https://seat.example.test/',
        '--pair',
        'vid_tp=vid_up',
        '--game',
        'gam_tp'
      ],
      io
    )
    assert.deepEqual(io.lines, [
      'vid_tp vs vid_up: match',
      'most recent played game: none (not gam_tp)'
    ])
    assert.equal(code, 1)
    assert.equal(programs[0], 'op-scotty')
    assert.ok(programs.includes('ffprobe'))
    const noGame = fakeIo(routes, io.run, io.env)
    assert.equal(
      await main(
        [
          'verify',
          '--app',
          'https://seat.example.test',
          '--pair',
          'vid_tp=vid_up'
        ],
        noGame
      ),
      0
    )
    routes['/playback'] = () =>
      Response.json({
        videoId: 'vid_tp',
        storage: 'spaces',
        url: null,
        expiresAt: null,
        durationSec: null,
        unavailable: true
      })
    await assert.rejects(
      main(
        [
          'verify',
          '--app',
          'https://seat.example.test',
          '--pair',
          'vid_tp=vid_up'
        ],
        fakeIo(routes, io.run, io.env)
      ),
      /vid_tp: no master playlist/
    )
  })

  it('reads a test account and its password from its own file', async function () {
    const file = join(dir, 'test-account.json')
    writeFileSync(
      file,
      JSON.stringify({ email: 'tester@example.test', password: 'not-real' })
    )
    const account = accountFrom({ TS_ACCOUNT_FILE: file })
    assert.deepEqual(account, {
      email: 'tester@example.test',
      item: '',
      vault: '',
      file
    })
    assert.equal(await passwordOf(account), 'not-real')
    const empty = join(dir, 'empty-account.json')
    writeFileSync(empty, JSON.stringify({ email: 'tester@example.test' }))
    await assert.rejects(
      passwordOf(accountFrom({ TS_ACCOUNT_FILE: empty })),
      /has no password/
    )
    writeFileSync(empty, '{}')
    assert.throws(() => accountFrom({ TS_ACCOUNT_FILE: empty }), /has no email/)
  })

  it('reads the account and its password from 1Password, and hashes like the app', async function () {
    assert.deepEqual(
      accountFrom({
        TS_ACCOUNT_EMAIL: 'player@example.test',
        TS_ACCOUNT_ITEM: 'item'
      }),
      {
        email: 'player@example.test',
        item: 'item',
        vault: 'Teamstation'
      }
    )
    assert.throws(() => accountFrom({}), /TS_ACCOUNT_EMAIL and TS_ACCOUNT_ITEM/)
    const asked: string[][] = []
    const password = await passwordOf(
      { email: 'e', item: 'item', vault: 'V' },
      async (program, args) => {
        asked.push([program, ...args])
        return {
          stdout: JSON.stringify({
            fields: [
              { label: 'username' },
              { purpose: 'PASSWORD', value: 'secret' }
            ]
          })
        }
      }
    )
    assert.equal(password, 'secret')
    assert.deepEqual(asked[0].slice(1, 5), ['item', 'get', 'item', '--vault'])
    await assert.rejects(
      passwordOf({ email: 'e', item: 'item', vault: 'V' }, async () => ({
        stdout: '{"fields":[]}'
      })),
      /item has no password/
    )
    const hashed = await nodePasswordKdf('password', {
      algorithm: 'argon2id',
      version: 19,
      memoryKiB: 19456,
      iterations: 2,
      parallelism: 1,
      hashLength: 32,
      salt: '00'.repeat(16)
    })
    assert.match(hashed, /^[0-9a-f]{64}$/)
  })
})
