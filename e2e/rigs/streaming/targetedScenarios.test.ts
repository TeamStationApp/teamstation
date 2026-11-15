import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { OwnerApi } from './ownerApi'
import type { Shaper } from './shaper'
import type { StreamingWorld } from './streamingSession'
import {
  type Look,
  type LookTile,
  type PublisherLike,
  Recorder,
  type StepRecord,
  type TargetedDriver,
  type TargetedSession,
  type Verdict,
  type Watcher,
  type WatcherRole
} from './targeted'
import {
  angleEnds,
  coldJoin,
  drift,
  gapSeek,
  ownerPanel,
  panelRowScript,
  publisherOutage,
  receiverOutage,
  tvCameras
} from './targetedScenarios'

/**
 * A fake targeted session on a virtual clock: sleeping moves the clock on, a
 * camera's cut leaves a hole in its footage, and each watcher plays live or
 * from where it was sought, paused or not. A watcher's `bugs` make it show
 * what a broken player would.
 */

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)

type Bug =
  | 'silent'
  | 'catchingUp'
  | 'stalled'
  | 'noClocks'
  | 'drift'
  | 'noPause'
  | 'noTiles'
  | 'unknownMotion'
  | 'notRecordingYet'

interface FakeWatcher extends Watcher {
  calls: string[]
}

interface World {
  clock: { t: number }
  labels: string[]
  holes: Map<string, Array<[number, number]>>
  ended: Map<string, number>
  publisherCalls: string[]
  endCalls: string[]
}

function makeWorld(labels: string[]): World {
  return {
    clock: { t: T0 },
    labels,
    holes: new Map(),
    ended: new Map(),
    publisherCalls: [],
    endCalls: []
  }
}

/** What a watcher plays: live, from a sought moment, or held paused. */
interface Playhead {
  anchor: number | null
  anchorAt: number
  paused: boolean
  frozen: number
}

function shown(head: Playhead, now: number): number {
  if (head.paused) return head.frozen
  if (head.anchor == null) return now
  return head.anchor + (now - head.anchorAt)
}

function watcher(
  world: World,
  role: WatcherRole,
  bugs: Bug[] = [],
  extra: Partial<Watcher> = {}
): FakeWatcher & { head: Playhead; look: () => Look } {
  const head: Playhead = { anchor: null, anchorAt: 0, paused: false, frozen: 0 }
  const calls: string[] = []
  const now = (): number => world.clock.t
  const look = (): Look => {
    const t = now()
    if (bugs.includes('noTiles')) {
      return { atMs: t, tiles: null, reason: 'the player is not up' }
    }
    const at = shown(head, t)
    const tiles = world.labels.map((angle): LookTile => {
      const endedAt = world.ended.get(angle)
      const out = (world.holes.get(angle) ?? []).some(
        ([start, end]) => (at >= start && at < end) || (t >= start && t < end)
      )
      if (bugs.includes('silent')) {
        return { angle, advancing: false, notice: null, wallMs: at }
      }
      if (endedAt != null && at >= endedAt) {
        return {
          angle,
          advancing: false,
          notice: bugs.includes('catchingUp')
            ? 'Camera catching up…'
            : 'This camera ended',
          wallMs: null
        }
      }
      if (out) {
        return {
          angle,
          advancing: false,
          notice: 'Waiting for this camera…',
          wallMs: null
        }
      }
      return {
        angle,
        advancing: bugs.includes('unknownMotion')
          ? null
          : !head.paused && !bugs.includes('stalled'),
        notice: bugs.includes('notRecordingYet') ? 'Not recording yet' : null,
        wallMs: bugs.includes('noClocks')
          ? null
          : at +
            (bugs.includes('drift') && angle === 'SynthC'
              ? Math.round((t - T0) / 1000)
              : 0)
      }
    })
    return { atMs: t, tiles }
  }
  const surface: TargetedDriver = {
    name: role,
    join: async () => {
      calls.push('join')
    },
    cut: async angle => {
      calls.push(`cut ${angle}`)
    },
    scrub: async () => {},
    rapidScrub: async () => {},
    skip: async steps => {
      calls.push(`skip ${(steps ?? []).join(',')}`)
    },
    slowMotion: async () => {},
    jumpToPresent: async () => {
      calls.push('jump')
      head.anchor = null
    },
    exitAndReenter: async () => {},
    relaunch: async () => {
      calls.push('relaunch')
      head.anchor = null
      head.paused = false
    },
    probe: async () => ({ tiles: [], bar: null, foreground: true }),
    ...(bugs.includes('noPause') || role === 'ipad'
      ? {}
      : {
          togglePause: async () => {
            calls.push('pause')
            if (head.paused) {
              head.anchor = head.frozen
              head.anchorAt = now()
              head.paused = false
            } else {
              head.frozen = shown(head, now())
              head.paused = true
            }
          }
        })
  }
  return { role, surface, calls, head, look, ...extra }
}

/** A promise-like that does `work` only once something waits for it. */
function awaited(work: () => void): PromiseLike<void> {
  const lazy = {
    then: (resolve: () => void) => {
      work()
      resolve()
    }
  }
  return lazy as unknown as PromiseLike<void>
}

interface Fake {
  session: TargetedSession
  world: World
  steps: StepRecord[]
}

function session(
  world: World,
  watchers: Array<ReturnType<typeof watcher>>,
  options: {
    shaper?: string
    shapedIps?: Record<string, string>
    noClocksOnSeek?: boolean
  } = {}
): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'targeted-scenarios-'))
  const now = (): number => world.clock.t
  const sleep = async (ms: number): Promise<void> => {
    world.clock.t += ms
  }
  const publishers = new Map<string, PublisherLike>()
  for (const label of world.labels) {
    const publisher = {
      start: async () => {
        world.publisherCalls.push(`start ${label}`)
      },
      stop: async () => {
        world.publisherCalls.push(`stop ${label}`)
        world.ended.set(label, now())
      },
      // The hole's end comes when the scenario waits for the cut, not before.
      cut: (seconds: number): PromiseLike<void> => {
        const start = now()
        const end = start + seconds * 1000
        world.publisherCalls.push(`cut ${label} ${seconds}`)
        world.holes.set(label, [
          ...(world.holes.get(label) ?? []),
          [start, end]
        ])
        return awaited(() => {
          world.clock.t = Math.max(world.clock.t, end)
        })
      }
    }
    publishers.set(label, publisher as unknown as PublisherLike)
  }
  const record = new Recorder(join(dir, 'targeted.jsonl'), name => name, now)
  const owner: OwnerApi = {
    endCamera: async (gameId, streamId) => {
      world.endCalls.push(`${gameId} ${streamId}`)
    }
  }
  const byWatcher = new Map<Watcher, ReturnType<typeof watcher>>(
    watchers.map(w => [w, w])
  )
  const fake: TargetedSession = {
    writeArtifact: () => undefined,
    world: {
      world: { gameId: 'g1', streams: [] },
      links: { web: 'https://app.example.test/games/g1?tab=watch' }
    } as unknown as StreamingWorld,
    watchers,
    publishers,
    owner,
    record,
    takeStartMs: T0,
    offsetMinutes: 0,
    streamId: label => `id-${label}`,
    look: async w => byWatcher.get(w)!.look(),
    seekTo: async (w, targetMs) => {
      const head = byWatcher.get(w)!.head
      const landed = Math.min(Math.max(targetMs, T0), now())
      head.anchor = landed
      head.anchorAt = now()
      if (head.paused) head.frozen = landed
      return options.noClocksOnSeek === true ? null : landed
    },
    sleep,
    now,
    ...(options.shaper == null ? {} : { shaper: options.shaper }),
    shapedIps: options.shapedIps ?? {}
  }
  return { session: fake, world, steps: record.steps }
}

function verdictsOf(steps: StepRecord[]): Array<[string, string, Verdict]> {
  return steps.map(step => [step.surface, step.step, step.verdict])
}

const THREE = ['SynthA', 'SynthB', 'SynthC']
const SHAPER = 'https://shaper.example.test'

describe('the gap-seek scenario', function () {
  it('pauses into the hole, plays on, and finds nothing before the take', async function () {
    const world = makeWorld(THREE)
    const chrome = watcher(world, 'chrome')
    const fake = session(world, [chrome])
    await gapSeek.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'gap-seek-paused-in-hole', 'passed'],
      ['chrome', 'gap-seek-resumed', 'passed'],
      ['chrome', 'gap-seek-before-take', 'passed']
    ])
    expect(world.publisherCalls).deep.equals(['cut SynthB 20'])
    expect(chrome.calls).deep.equals(['pause', 'pause', 'jump'])
    expect(fake.steps[0].observed).contains('"Waiting for this camera…"')
  })

  it('blocks a watcher that cannot pause and fails one that shows no hole', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [
      watcher(world, 'ipad'),
      watcher(world, 'iphone', ['silent']),
      watcher(world, 'android', ['notRecordingYet'])
    ])
    await gapSeek.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['ipad', 'gap-seek-paused', 'blocked'],
      ['iphone', 'gap-seek-paused-in-hole', 'failed'],
      ['iphone', 'gap-seek-resumed', 'failed'],
      ['iphone', 'gap-seek-before-take', 'passed'],
      ['android', 'gap-seek-paused-in-hole', 'passed'],
      ['android', 'gap-seek-resumed', 'passed'],
      ['android', 'gap-seek-before-take', 'failed']
    ])
  })

  it('says where a seek landed when the clocks could not be read', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [watcher(world, 'chrome')], {
      noClocksOnSeek: true
    })
    await gapSeek.run(fake.session)
    expect(fake.steps[0].observed).match(/^landed unread;/)
    expect(fake.steps[0].verdict).equals('failed')
  })
})

describe('the angle-ends scenario', function () {
  it('shows the ended camera ended, then seeks the finished game', async function () {
    const world = makeWorld(THREE)
    const chrome = watcher(world, 'chrome')
    const fake = session(world, [chrome])
    await angleEnds.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'angle-ends', 'passed'],
      ['chrome', 'finished-game-seek', 'passed']
    ])
    expect(world.endCalls).deep.equals([
      'g1 id-SynthC',
      'g1 id-SynthA',
      'g1 id-SynthB'
    ])
    expect(chrome.calls).deep.equals(['relaunch'])
    expect(fake.steps[1].observed).match(/^landed 0 s from the middle;/)
  })

  it('fails a watcher that says catching up, and one whose seek is unread', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [watcher(world, 'iphone', ['catchingUp'])], {
      noClocksOnSeek: true
    })
    await angleEnds.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['iphone', 'angle-ends', 'failed'],
      ['iphone', 'finished-game-seek', 'failed']
    ])
    expect(fake.steps[0].observed).match(/^said catching up; /)
    expect(fake.steps[1].observed).match(/^landed unread;/)
  })
})

describe('the publisher-outage scenario', function () {
  it('says the camera is out, then has it rejoin live and rewound', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [watcher(world, 'chrome')])
    await publisherOutage.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'publisher-outage-live-during', 'passed'],
      ['chrome', 'publisher-outage-live-after', 'passed'],
      ['chrome', 'publisher-outage-rewound-during', 'passed'],
      ['chrome', 'publisher-outage-rewound-after', 'passed']
    ])
    expect(world.publisherCalls).deep.equals(['cut SynthA 45', 'cut SynthA 45'])
  })

  it('fails a watcher that freezes silently', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [watcher(world, 'android', ['silent'])])
    await publisherOutage.run(fake.session)
    expect(fake.steps.map(step => step.verdict)).deep.equals([
      'failed',
      'failed',
      'failed',
      'failed'
    ])
  })
})

describe('the receiver-outage scenario', function () {
  function conditioner(
    world: World,
    onNetwork: string[]
  ): { shaper: Shaper; outages: string[] } {
    const outages: string[] = []
    return {
      outages,
      shaper: {
        onTestNetwork: async ip =>
          onNetwork.includes(ip)
            ? { ip, hostname: null, ssid: 'test-net-1' }
            : null,
        outage: async (ip, ms) => {
          outages.push(`${ip} ${ms}`)
          world.clock.t += ms
          return undefined
        }
      }
    }
  }

  it('plays on after the outage, and holds a paused moment through another', async function () {
    const world = makeWorld(THREE)
    const { shaper, outages } = conditioner(world, ['192.0.2.1', '192.0.2.3'])
    const fake = session(
      world,
      [
        watcher(world, 'iphone'),
        watcher(world, 'android'),
        watcher(world, 'ipad'),
        watcher(world, 'chrome')
      ],
      {
        shaper: SHAPER,
        shapedIps: {
          iphone: '192.0.2.1',
          android: '192.0.2.2',
          ipad: '192.0.2.3'
        }
      }
    )
    const asked: string[] = []
    await receiverOutage(base => {
      asked.push(base)
      return shaper
    }).run(fake.session)
    expect(asked).deep.equals([SHAPER])
    expect(verdictsOf(fake.steps)).deep.equals([
      ['iphone', 'receiver-outage-playing', 'passed'],
      ['iphone', 'receiver-outage-paused', 'passed'],
      ['iphone', 'receiver-outage-resumed', 'passed'],
      ['android', 'receiver-outage', 'blocked'],
      ['ipad', 'receiver-outage-playing', 'passed'],
      ['chrome', 'receiver-outage', 'blocked']
    ])
    expect(fake.steps[3].observed).equals(
      '192.0.2.2 is not on a test network the conditioner shapes'
    )
    expect(fake.steps[5].observed).equals(
      'no address for chrome in soak.shapedIps'
    )
    expect(outages).deep.equals([
      '192.0.2.1 180000',
      '192.0.2.1 180000',
      '192.0.2.3 180000'
    ])
  })

  it('fails a watcher that plays on when it should stay paused', async function () {
    const world = makeWorld(THREE)
    const { shaper } = conditioner(world, ['192.0.2.1'])
    const broken = watcher(world, 'iphone')
    // Its pause toggles nothing: the picture keeps moving.
    broken.surface.togglePause = async () => {}
    const fake = session(world, [broken], {
      shaper: SHAPER,
      shapedIps: { iphone: '192.0.2.1' }
    })
    await receiverOutage(() => shaper).run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['iphone', 'receiver-outage-playing', 'passed'],
      ['iphone', 'receiver-outage-paused', 'failed'],
      ['iphone', 'receiver-outage-resumed', 'passed']
    ])
    const unread = makeWorld(THREE)
    const none = conditioner(unread, ['192.0.2.1'])
    const noClocks = session(
      unread,
      [watcher(unread, 'iphone', ['noClocks'])],
      {
        shaper: SHAPER,
        shapedIps: { iphone: '192.0.2.1' }
      }
    )
    await receiverOutage(() => none.shaper).run(noClocks.session)
    expect(noClocks.steps[1].observed).match(/^held unread; /)
    expect(noClocks.steps[1].verdict).equals('failed')
  })

  it('blocks every watcher when the local settings name no conditioner', async function () {
    const world = makeWorld(THREE)
    const { shaper, outages } = conditioner(world, ['192.0.2.1'])
    const fake = session(
      world,
      [watcher(world, 'iphone'), watcher(world, 'android')],
      { shapedIps: { iphone: '192.0.2.1' } }
    )
    await receiverOutage(() => shaper).run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['iphone', 'receiver-outage', 'blocked'],
      ['android', 'receiver-outage', 'blocked']
    ])
    expect(fake.steps[0].observed).equals(
      "the local settings' soak block names no shaper"
    )
    expect(outages).deep.equals([])
  })

  it('builds its own conditioner unless told otherwise', function () {
    expect(receiverOutage().setup.watchers).deep.equals([
      'iphone',
      'android',
      'ipad'
    ])
  })
})

describe('the drift scenario', function () {
  it('passes tiles that stay together, fails ones that drift, blocks unread clocks', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [
      watcher(world, 'chrome'),
      watcher(world, 'iphone', ['drift']),
      watcher(world, 'android', ['noClocks'])
    ])
    await drift.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'drift', 'passed'],
      ['iphone', 'drift', 'failed'],
      ['android', 'drift', 'blocked']
    ])
    expect(world.clock.t - T0).equals(32 * 60_000)
    expect(fake.steps[2].observed).equals('read 0 of 31')
    expect(fake.steps[1].observed).match(/worst \d+, growth \d+$/)
  })
})

describe('the cold-join scenario', function () {
  it('relaunches five times and wants every tile moving each time', async function () {
    const world = makeWorld(THREE)
    const good = watcher(world, 'chrome')
    const fake = session(world, [
      good,
      watcher(world, 'iphone', ['stalled']),
      watcher(world, 'android', ['noTiles']),
      watcher(world, 'ipad', ['unknownMotion'])
    ])
    await coldJoin.run(fake.session)
    const by = (role: string): Verdict[] =>
      fake.steps.filter(step => step.surface === role).map(step => step.verdict)
    expect(by('chrome')).deep.equals(Array(5).fill('passed'))
    expect(by('iphone')).deep.equals(Array(5).fill('failed'))
    expect(by('android')).deep.equals(Array(5).fill('failed'))
    expect(by('ipad')).deep.equals(Array(5).fill('failed'))
    expect(good.calls).deep.equals(Array(5).fill('relaunch'))
    const observed = (role: string): string =>
      fake.steps.find(step => step.surface === role)!.observed
    expect(observed('android')).equals('no tiles (the player is not up)')
    expect(observed('iphone')).contains('SynthA: still @')
    expect(observed('ipad')).contains('SynthA: ? @')
  })
})

describe("the owner's camera panel scenario", function () {
  function chrome(
    world: World,
    row: () => string | null,
    requests: string[] = ['r1', 'r2']
  ): {
    watcher: ReturnType<typeof watcher>
    sent: Array<[string, unknown]>
    opened: string[]
  } {
    const sent: Array<[string, unknown]> = []
    const opened: string[] = []
    let paused: ((params: { requestId: string }) => void) | undefined
    const w = watcher(world, 'chrome', [], {
      cdp: {
        send: async (method, params) => {
          sent.push([method, params])
          if (method === 'Fetch.enable') {
            for (const requestId of requests) paused?.({ requestId })
          }
          return {}
        },
        on: (event, listener) => {
          expect(event).equals('Fetch.requestPaused')
          paused = listener
        }
      },
      evaluate: async script => {
        expect(script).equals(panelRowScript('SynthC'))
        return row()
      },
      open: async link => {
        opened.push(link)
      }
    })
    return { watcher: w, sent, opened }
  }

  it('holds a read unanswered, ends a camera, and sees the panel catch up', async function () {
    const world = makeWorld(THREE)
    const {
      watcher: w,
      sent,
      opened
    } = chrome(world, () =>
      world.ended.has('SynthC') ? 'SynthC · Ended' : 'SynthC · Live'
    )
    const fake = session(world, [w])
    await ownerPanel.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'owner-panel-unanswered-read', 'passed']
    ])
    expect(opened).deep.equals(['https://app.example.test/games/g1?tab=watch'])
    expect(sent.map(([method, params]) => [method, params])).deep.equals([
      [
        'Fetch.enable',
        {
          patterns: [{ urlPattern: '*live-streams*', requestStage: 'Request' }]
        }
      ],
      ['Fetch.continueRequest', { requestId: 'r2' }],
      ['Fetch.continueRequest', { requestId: 'r1' }],
      ['Fetch.disable', undefined]
    ])
    expect(world.endCalls).deep.equals(['g1 id-SynthC'])
  })

  it('fails when no read was held or the panel never says ended', async function () {
    const world = makeWorld(THREE)
    const { watcher: w } = chrome(world, () => null, [])
    const fake = session(world, [w])
    await ownerPanel.run(fake.session)
    expect(fake.steps[0].verdict).equals('failed')
    expect(fake.steps[0].observed).equals('no read was held; row: null')
  })

  it('blocks without a DevTools session', async function () {
    const world = makeWorld(THREE)
    const fake = session(world, [watcher(world, 'chrome')])
    await ownerPanel.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['chrome', 'owner-panel', 'blocked']
    ])
  })

  it("finds the shortest row that names the camera in Chrome's page", function () {
    const run = (texts: string[]): unknown =>
      runInNewContext(panelRowScript('SynthC'), {
        document: {
          querySelectorAll: () => texts.map(innerText => ({ innerText }))
        }
      })
    expect(
      run([
        'SynthA · Live',
        'Cameras SynthC · Ended and more',
        'SynthC · Ended'
      ])
    ).equals('SynthC · Ended')
    expect(run(['SynthA · Live', 'x'.repeat(300) + 'SynthC'])).equals(null)
  })
})

describe('the TV scenario', function () {
  const FOUR = ['SynthA', 'SynthB', 'SynthC', 'SynthD']

  function tv(
    world: World,
    dumps: () => string
  ): { watcher: ReturnType<typeof watcher>; control: string[] } {
    const control: string[] = []
    const w = watcher(world, 'tv', [], {
      tv: {
        coldLaunch: async () => {
          control.push('launch')
        },
        dump: async () => dumps(),
        approve: async () => {
          control.push('approve')
          return true
        }
      }
    })
    return { watcher: w, control }
  }

  it('starts cold, offers four cameras, skips, rides an outage and an ending', async function () {
    const world = makeWorld(FOUR)
    const { watcher: w, control } = tv(world, () => 'Sign in: ABCD-EFGH')
    const fake = session(world, [w])
    await tvCameras.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['tv', 'tv-cold-start', 'passed'],
      ['tv', 'tv-cameras-offered', 'passed'],
      ['tv', 'tv-skip-inside', 'passed'],
      ['tv', 'tv-publisher-outage', 'passed'],
      ['tv', 'tv-camera-ended', 'passed']
    ])
    expect(fake.steps[0].observed).equals('it shows its sign-in code')
    expect(control).deep.equals(['launch', 'approve'])
    expect(w.calls).deep.equals(['join', 'cut SynthD', 'skip 10,-10,-10'])
    expect(world.endCalls).deep.equals(['g1 id-SynthD'])
  })

  it('names its home as a start', async function () {
    const world = makeWorld(FOUR)
    const fake = session(world, [tv(world, () => 'tv-page-home').watcher])
    await tvCameras.run(fake.session)
    expect(fake.steps[0].observed).equals('it shows its home')
  })

  it('blocks the rest when the TV hangs on Connecting or shows something else', async function () {
    for (const [dump, shows] of [
      ['Connecting…', '"Connecting…"'],
      ['Loading', 'something else']
    ]) {
      const world = makeWorld(FOUR)
      const { watcher: w, control } = tv(world, () => dump)
      const fake = session(world, [w])
      await tvCameras.run(fake.session)
      expect(verdictsOf(fake.steps)).deep.equals([
        ['tv', 'tv-cold-start', 'failed'],
        ['tv', 'tv-cameras', 'blocked']
      ])
      expect(fake.steps[0].observed).equals(`it shows ${shows}`)
      expect(control).deep.equals(['launch'])
    }
  })

  it('fails a TV whose player shows no tiles', async function () {
    const world = makeWorld(['SynthA', 'SynthB', 'SynthD'])
    const fake = session(world, [
      watcher(world, 'tv', ['noTiles'], {
        tv: {
          coldLaunch: async () => {},
          dump: async () => 'Welcome',
          approve: async () => false
        }
      })
    ])
    await tvCameras.run(fake.session)
    expect(verdictsOf(fake.steps)).deep.equals([
      ['tv', 'tv-cold-start', 'passed'],
      ['tv', 'tv-cameras-offered', 'failed'],
      ['tv', 'tv-skip-inside', 'failed'],
      ['tv', 'tv-publisher-outage', 'passed'],
      ['tv', 'tv-camera-ended', 'failed']
    ])
  })
})
