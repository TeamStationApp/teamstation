import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  evaluateGates,
  type GateInstance,
  type GateName,
  overallVerdict
} from './soakGates'
import type { ProbeTile, RecordedEvent, RecordedProbe } from './soakRecords'
import type { SoakSurface } from './soakSchedule'

const T0 = 1_000_000

/** Three publishers up from T0, every watcher joined by T0 + 1 s. */
function base(): RecordedEvent[] {
  return [
    { atMs: T0, target: 'publisherA', action: 'startPublisher' },
    { atMs: T0, target: 'publisherB', action: 'startPublisher' },
    { atMs: T0, target: 'publisherC', action: 'startPublisher' },
    ...(['iphone-app', 'android', 'ipad', 'tv', 'chrome'] as const).map(
      surface => ({
        atMs: T0 + 500,
        doneMs: T0 + 1000,
        target: surface,
        action: 'join'
      })
    )
  ]
}

type TileSpec = Partial<Record<string, boolean | null | ProbeTile>>

function probe(
  surface: SoakSurface,
  atMs: number,
  tiles: TileSpec | null = {},
  extra: Partial<RecordedProbe> = {}
): RecordedProbe {
  const all: TileSpec = {
    'Phone A': true,
    'Phone B': true,
    Synthetic: true,
    ...tiles
  }
  return {
    atMs,
    surface,
    tiles:
      tiles == null
        ? null
        : Object.entries(all).flatMap(([angle, value]) => {
            if (value === undefined) return []
            if (value != null && typeof value === 'object') return [value]
            return [{ angle, advancing: value, notice: null }]
          }),
    bar: null,
    foreground: true,
    ...extra
  }
}

function only(
  instances: GateInstance[],
  gate: GateName,
  surface?: SoakSurface
): GateInstance[] {
  return instances.filter(
    instance =>
      instance.gate === gate &&
      (surface == null || instance.surface === surface)
  )
}

/** One action at T0 + 60 s on Chrome, done at once, then probes at the given offsets. */
function afterAction(
  action: string,
  frozenUntil: number,
  probeAt: number[],
  args: Record<string, unknown> = {}
): GateInstance {
  const at = T0 + 60_000
  const events = [
    ...base(),
    { atMs: at, doneMs: at, target: 'chrome', action, args }
  ]
  const probes = probeAt.map(offset =>
    probe(
      'chrome',
      at + offset,
      offset < frozenUntil ? { 'Phone A': false } : {}
    )
  )
  const { instances } = evaluateGates(events, probes)
  return instances.find(instance => instance.kind === action)!
}

describe('the soak gates', function () {
  describe('seek recovery', function () {
    it('passes when every angle advances at exactly 5 s', function () {
      const judged = afterAction('scrubLeft', 5000, [1000, 5000])
      expect(judged.gate).equals('seekRecovery')
      expect(judged.verdict).equals('passed')
      expect(judged.recoveredInMs).equals(5000)
    })

    it('fails when recovery takes a millisecond longer', function () {
      const judged = afterAction('skip', 5001, [1000, 5000, 5001])
      expect(judged.verdict).equals('failed')
      expect(judged.reason).match(/within 5 s/)
    })

    it('judges slow motion, rapid scrubs and Jump to present the same way', function () {
      for (const kind of [
        'slowMotion',
        'rapidScrub',
        'jumpToPresent',
        'scrubRight'
      ]) {
        expect(afterAction(kind, 0, [2000]).gate).equals('seekRecovery')
      }
    })
  })

  describe('re-entry', function () {
    it('passes at exactly 20 s after a relaunch and fails just after', function () {
      expect(afterAction('relaunch', 20000, [19000, 20000]).verdict).equals(
        'passed'
      )
      const late = afterAction('exitAndReenter', 20001, [19000, 20001])
      expect(late.gate).equals('reentry')
      expect(late.verdict).equals('failed')
    })
  })

  describe('camera cut', function () {
    it('needs the chosen angle advancing within 5 s, and lets hidden ones go', function () {
      const at = T0 + 60_000
      const events = [
        ...base(),
        {
          atMs: at,
          doneMs: at,
          target: 'chrome',
          action: 'cameraCut',
          args: { angle: 'Phone B' }
        }
      ]
      const hidden = evaluateGates(events, [
        probe('chrome', at + 5000, {
          'Phone A': undefined,
          Synthetic: undefined
        })
      ])
      expect(
        hidden.instances.find(i => i.gate === 'cameraCut')!.verdict
      ).equals('passed')
      const frozenOther = evaluateGates(events, [
        probe('chrome', at + 5000, { Synthetic: false })
      ])
      expect(
        frozenOther.instances.find(i => i.gate === 'cameraCut')!.verdict
      ).equals('failed')
      const chosenFrozen = evaluateGates(events, [
        probe('chrome', at + 5000, { 'Phone B': false })
      ])
      expect(
        chosenFrozen.instances.find(i => i.gate === 'cameraCut')!.verdict
      ).equals('failed')
    })
  })

  describe('surface switch', function () {
    const at = T0 + 600_000
    function switched(
      offset: number,
      outcome?: { reloaded?: boolean }
    ): GateInstance {
      const events = [
        ...base(),
        {
          atMs: at,
          doneMs: at,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'safari' },
          outcome
        }
      ]
      const probes = [probe('iphone-safari', at + offset)]
      if (offset > 1000) {
        probes.unshift(probe('iphone-safari', at + 1000, { 'Phone A': false }))
      }
      return only(evaluateGates(events, probes).instances, 'surfaceSwitch')[0]
    }

    it('passes on the surface brought forward at exactly 15 s', function () {
      const judged = switched(15000)
      expect(judged.surface).equals('iphone-safari')
      expect(judged.verdict).equals('passed')
    })

    it('fails past 15 s, or when the page reloaded', function () {
      expect(switched(15001).verdict).equals('failed')
      expect(switched(1000, { reloaded: true }).verdict).equals('failed')
    })

    it('routes the iPhone target to whichever surface is in front', function () {
      const events = [
        ...base(),
        {
          atMs: T0 + 10_000,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'safari' }
        },
        {
          atMs: T0 + 60_000,
          doneMs: T0 + 60_000,
          target: 'iphone',
          action: 'skip'
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('iphone-safari', T0 + 61_000)
      ])
      expect(instances.find(i => i.kind === 'skip')!.surface).equals(
        'iphone-safari'
      )
    })
  })

  describe('synthetic outage', function () {
    const cutAt = T0 + 300_000
    const restored = cutAt + 30_000
    function outage(
      probes: RecordedProbe[],
      extra: RecordedEvent[] = []
    ): GateInstance {
      const events = [
        ...base(),
        {
          atMs: cutAt,
          doneMs: restored,
          target: 'publisherC',
          action: 'syntheticCut',
          args: { seconds: 30 }
        },
        ...extra
      ]
      return only(
        evaluateGates(events, probes).instances,
        'syntheticOutage',
        'chrome'
      )[0]
    }
    const waiting: ProbeTile = {
      angle: 'Synthetic',
      advancing: false,
      notice: 'Waiting for this camera to catch up to the game…'
    }

    it('passes with a truthful notice, A and B playing, and C back at exactly 60 s', function () {
      const judged = outage([
        probe('chrome', cutAt + 2000, { Synthetic: false }),
        probe('chrome', cutAt + 15_000, { Synthetic: waiting }),
        probe('chrome', restored + 30_000, { Synthetic: false }),
        probe('chrome', restored + 60_000)
      ])
      expect(judged.verdict).equals('passed')
      expect(judged.recoveredInMs).equals(60_000)
    })

    it('fails when C comes back a millisecond past 60 s', function () {
      const judged = outage([
        probe('chrome', cutAt + 15_000, { Synthetic: waiting }),
        probe('chrome', restored + 59_000, { Synthetic: false }),
        probe('chrome', restored + 60_001)
      ])
      expect(judged.verdict).equals('failed')
      expect(judged.reason).match(/did not advance within 60 s/)
    })

    it('fails when C claims to play or says nothing, or A stops', function () {
      expect(
        outage([
          probe('chrome', cutAt + 15_000, { Synthetic: false }),
          probe('chrome', restored + 1000)
        ]).reason
      ).match(/C showed null/)
      expect(
        outage([
          probe('chrome', cutAt + 15_000, { Synthetic: undefined }),
          probe('chrome', restored + 1000)
        ]).reason
      ).match(/no tile/)
      expect(
        outage([
          probe('chrome', cutAt + 15_000, {
            Synthetic: waiting,
            'Phone A': false
          }),
          probe('chrome', restored + 1000)
        ]).reason
      ).match(/another angle stopped/)
    })

    it('is blocked when a rejoin overlapped it, or nothing answered', function () {
      expect(
        outage(
          [probe('chrome', restored + 1000)],
          [{ atMs: cutAt + 5000, target: 'chrome', action: 'relaunch' }]
        ).verdict
      ).equals('blocked')
      expect(
        outage([
          probe('chrome', cutAt + 15_000, null),
          probe('chrome', restored + 1000, null)
        ]).verdict
      ).equals('blocked')
    })

    it('is left out of continuous play, for C alone', function () {
      const events = [
        ...base(),
        {
          atMs: cutAt,
          doneMs: restored,
          target: 'publisherC',
          action: 'syntheticCut',
          args: { seconds: 30 }
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('chrome', cutAt + 15_000, { Synthetic: waiting }),
        probe('chrome', restored + 30_000, { Synthetic: false }),
        probe('chrome', cutAt + 16_000, {
          Synthetic: waiting,
          'Phone B': false
        })
      ])
      const play = only(instances, 'continuousPlay', 'chrome')
      expect(play.map(i => i.verdict)).deep.equals([
        'passed',
        'failed',
        'passed'
      ])
    })
  })

  describe('continuous play', function () {
    it('excuses the window after an action, and judges the rest', function () {
      const at = T0 + 60_000
      const events = [
        ...base(),
        { atMs: at, doneMs: at + 1000, target: 'android', action: 'skip' }
      ]
      const { instances } = evaluateGates(events, [
        probe('android', at + 3000, { 'Phone A': false }),
        probe('android', at + 7000, { 'Phone A': false }),
        probe('android', at + 30_000)
      ])
      const play = only(instances, 'continuousPlay', 'android')
      expect(play.map(i => i.verdict)).deep.equals(['failed', 'passed'])
      expect(play[0].atMs).equals(at + 7000)
    })

    it('counts a probe the surface could not answer as blocked, never passed', function () {
      const { instances, verdict } = evaluateGates(base(), [
        probe('ipad', T0 + 60_000, null, {
          reason: 'no hierarchy',
          foreground: null
        }),
        probe('ipad', T0 + 90_000, { 'Phone B': null }, { foreground: null })
      ])
      expect(only(instances, 'continuousPlay').map(i => i.verdict)).deep.equals(
        ['blocked', 'blocked']
      )
      expect(only(instances, 'continuousPlay')[0].reason).equals('no hierarchy')
      expect(only(instances, 'noCrash')[0].verdict).equals('blocked')
      expect(verdict).equals('blocked')
    })

    it('judges nothing once the publishers stop', function () {
      const events = [
        ...base(),
        { atMs: T0 + 50_000, target: 'publishers', action: 'stopPublishers' }
      ]
      const { instances } = evaluateGates(events, [
        probe('tv', T0 + 60_000, { 'Phone A': false })
      ])
      expect(only(instances, 'continuousPlay')).deep.equals([])
    })
  })

  describe('a probe nobody could answer and an action that threw', function () {
    it('is blocked', function () {
      const at = T0 + 60_000
      const events = [
        ...base(),
        { atMs: at, target: 'tv', action: 'scrubLeft', error: 'no bar' },
        {
          atMs: at + 30_000,
          doneMs: at + 30_000,
          target: 'tv',
          action: 'skip'
        },
        {
          atMs: at + 60_000,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'app' },
          error: 'Home failed'
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('tv', at + 31_000, null)
      ])
      expect(instances.find(i => i.kind === 'scrubLeft')!.verdict).equals(
        'blocked'
      )
      expect(instances.find(i => i.kind === 'scrubLeft')!.reason).match(
        /no bar/
      )
      expect(instances.find(i => i.kind === 'skip')!.verdict).equals('blocked')
      expect(only(instances, 'surfaceSwitch')[0].verdict).equals('blocked')
    })
  })

  describe('no stuck tile', function () {
    function stuckFor(ms: number, notice: string | null = null): GateInstance {
      const from = T0 + 100_000
      const tile: ProbeTile = {
        angle: 'Phone A',
        advancing: notice != null,
        notice
      }
      const { instances } = evaluateGates(base(), [
        probe('chrome', from - 1000),
        probe('chrome', from, { 'Phone A': tile }),
        probe('chrome', from + ms / 2, null),
        probe('chrome', from + ms, { 'Phone A': tile }),
        probe('chrome', from + ms + 1000)
      ])
      return only(instances, 'noStuckTile').find(
        i => i.reason?.startsWith('Phone A') === true
      )!
    }

    it('allows exactly 60 s, and fails a tile stuck longer', function () {
      expect(stuckFor(60_000).verdict).equals('passed')
      const stuck = stuckFor(61_000)
      expect(stuck.verdict).equals('failed')
      expect(stuck.reason).match(/stuck 61 s/)
    })

    it('counts a "catching up" notice as stuck even while pictures move', function () {
      expect(stuckFor(61_000, 'Camera catching up…').verdict).equals('failed')
    })

    it('does not bridge the time a surface was behind the other', function () {
      const events = [
        ...base(),
        {
          atMs: T0 + 50_000,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'safari' }
        },
        {
          atMs: T0 + 200_000,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'app' }
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('iphone-app', T0 + 40_000, { 'Phone A': false }),
        probe('iphone-app', T0 + 240_000, { 'Phone A': false })
      ])
      const phoneA = only(instances, 'noStuckTile', 'iphone-app').find(
        i => i.reason?.startsWith('Phone A') === true
      )!
      expect(phoneA.verdict).equals('passed')
    })

    it('is blocked for an angle never answered, and ignores C while it is down', function () {
      const events = [
        ...base(),
        {
          atMs: T0 + 30_000,
          doneMs: T0 + 200_000,
          target: 'publisherC',
          action: 'syntheticCut',
          args: { seconds: 170 }
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('ipad', T0 + 40_000, { Synthetic: false, 'Phone B': null }),
        probe('ipad', T0 + 190_000, { Synthetic: false, 'Phone B': null })
      ])
      const rows = only(instances, 'noStuckTile', 'ipad')
      expect(
        rows.find(i => i.reason?.startsWith('Synthetic') === true)!.verdict
      ).equals('blocked')
      expect(
        rows.find(i => i.reason?.startsWith('Phone B') === true)!.verdict
      ).equals('blocked')
    })
  })

  describe('no crash', function () {
    it('fails when the app leaves the foreground or the session goes', function () {
      const left = evaluateGates(base(), [
        probe('android', T0 + 60_000),
        probe('android', T0 + 90_000, {}, { foreground: false })
      ])
      expect(only(left.instances, 'noCrash')[0].verdict).equals('failed')
      const lost = evaluateGates(base(), [
        probe('chrome', T0 + 60_000, {}, { sessionLost: true })
      ])
      expect(only(lost.instances, 'noCrash')[0].reason).match(/session/)
    })

    it('excuses a scheduled relaunch and a surface switch', function () {
      const events = [
        ...base(),
        {
          atMs: T0 + 60_000,
          doneMs: T0 + 70_000,
          target: 'android',
          action: 'relaunch'
        },
        {
          atMs: T0 + 120_000,
          doneMs: T0 + 121_000,
          target: 'iphone',
          action: 'switchSurface',
          args: { to: 'app' }
        }
      ]
      const { instances } = evaluateGates(events, [
        probe('android', T0 + 65_000, {}, { foreground: false }),
        probe('android', T0 + 95_000),
        probe('iphone-app', T0 + 125_000, {}, { foreground: false }),
        probe('iphone-app', T0 + 150_000)
      ])
      expect(only(instances, 'noCrash').map(i => i.verdict)).deep.equals([
        'passed',
        'passed'
      ])
    })
  })

  describe('counts and classification', function () {
    it('counts passed out of run per surface and kind, and marks repeats', function () {
      const events = [...base()]
      const probes: RecordedProbe[] = []
      // Three skips on Android: two fail, one passes. One scrub fails.
      for (const [index, fails] of [true, false, true].entries()) {
        const at = T0 + 100_000 * (index + 1)
        events.push({ atMs: at, doneMs: at, target: 'android', action: 'skip' })
        probes.push(
          probe('android', at + 2000, fails ? { 'Phone A': false } : {})
        )
      }
      events.push({
        atMs: T0 + 500_000,
        doneMs: T0 + 500_000,
        target: 'android',
        action: 'scrubLeft'
      })
      probes.push(probe('android', T0 + 502_000, { 'Phone B': false }))
      const report = evaluateGates(events, probes)
      const skip = report.counts.find(
        c => c.surface === 'android' && c.kind === 'skip'
      )!
      expect(skip).deep.include({ run: 3, passed: 1, failed: 2, blocked: 0 })
      const failures = report.instances.filter(i => i.verdict === 'failed')
      expect(
        failures.filter(i => i.kind === 'skip').map(i => i.recurrence)
      ).deep.equals(['repeated', 'repeated'])
      expect(failures.find(i => i.kind === 'scrubLeft')!.recurrence).equals(
        'single'
      )
      expect(report.verdict).equals('failed')
    })

    it('passes a clean run, and blocks one with nothing recorded', function () {
      const clean = evaluateGates(base(), [
        probe('tv', T0 + 60_000),
        probe('tv', T0 + 90_000)
      ])
      expect(clean.verdict).equals('passed')
      expect(evaluateGates([], []).verdict).equals('blocked')
      expect(overallVerdict(['passed', 'blocked'])).equals('blocked')
      expect(overallVerdict(['blocked', 'failed'])).equals('failed')
    })
  })
})
