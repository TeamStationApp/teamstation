import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ACTION_KINDS,
  FULL_CUTS,
  FULL_LENGTH_SEC,
  iphoneFrontAt,
  MIN_COMPRESSED_SEC,
  minutesFromEnv,
  OUTAGE_RECOVERY_SEC,
  seededRandom,
  type SoakSchedule,
  soakSchedule,
  SURFACES
} from './soakSchedule'

const MIN = 60

function kindCounts(
  schedule: SoakSchedule,
  from = 0,
  to = Infinity
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {}
  for (const surface of SURFACES) {
    counts[surface] = Object.fromEntries(ACTION_KINDS.map(kind => [kind, 0]))
  }
  for (const event of schedule.events) {
    if (event.atSec < from || event.atSec >= to) continue
    const row = counts[event.target]
    if (row?.[event.action] != null) row[event.action]++
  }
  return counts
}

describe('the soak schedule', function () {
  it('gives the same timeline for the same seed, and another for another seed', function () {
    expect(soakSchedule({ seed: 'a' })).deep.equals(soakSchedule({ seed: 'a' }))
    expect(soakSchedule({ seed: 'a' }).events).not.deep.equals(
      soakSchedule({ seed: 'b' }).events
    )
    expect(soakSchedule().seed).equals('streaming-soak')
    expect(seededRandom('x')()).equals(seededRandom('x')())
  })

  it('puts one event in each 30 s slot over two hours', function () {
    const schedule = soakSchedule()
    expect(schedule.layout).equals('full')
    expect(schedule.lengthSec).equals(FULL_LENGTH_SEC)
    const seconds = schedule.events.map(event => event.atSec)
    expect(new Set(seconds).size).equals(seconds.length)
    expect(seconds.every(at => at % 30 === 0)).equals(true)
    expect(seconds).deep.equals([...seconds].sort((a, b) => a - b))
    // Every slot from 15 to 115 min is used.
    const busy = seconds.filter(at => at >= 15 * MIN && at < 115 * MIN)
    expect(busy.length).equals(200)
  })

  it('starts the publishers 60 s apart, joins every watcher, and stops at the end', function () {
    const { events } = soakSchedule()
    expect(
      events
        .filter(event => event.action === 'startPublisher')
        .map(event => [event.atSec, event.target])
    ).deep.equals([
      [0, 'publisherA'],
      [60, 'publisherB'],
      [120, 'publisherC']
    ])
    const joins = events.filter(event => event.action === 'join')
    expect(joins.map(event => event.target)).deep.equals([
      'iphone-app',
      'android',
      'ipad',
      'tv',
      'chrome'
    ])
    expect(joins.every(event => event.atSec < 5 * MIN)).equals(true)
    expect(events.at(-1)).deep.equals({
      atSec: 7200,
      target: 'publishers',
      action: 'stopPublishers',
      args: {}
    })
  })

  it('keeps warm-up and the quiet end free of actions', function () {
    const { events } = soakSchedule()
    const quiet = events.filter(
      event =>
        (event.atSec >= 5 * MIN && event.atSec < 15 * MIN) ||
        (event.atSec >= 115 * MIN && event.atSec < 120 * MIN)
    )
    expect(quiet).deep.equals([])
  })

  it('has every kind at least three times on every surface between 15 and 115 min', function () {
    const counts = kindCounts(soakSchedule(), 15 * MIN, 115 * MIN)
    for (const surface of SURFACES) {
      for (const kind of ACTION_KINDS) {
        expect(counts[surface][kind], `${surface} ${kind}`).gte(3)
      }
    }
  })

  it('cuts the synthetic source eight times, at its minutes and durations', function () {
    const cuts = soakSchedule().events.filter(
      event => event.action === 'syntheticCut'
    )
    expect(
      cuts.map(event => [
        event.atSec / MIN,
        event.args.seconds,
        event.args.discontinuity
      ])
    ).deep.equals([
      [25, 30, false],
      [35, 10, false],
      [45, 60, false],
      [55, 5, false],
      [70, 120, false],
      [82, 30, true],
      [95, 30, false],
      [105, 15, false]
    ])
    expect(cuts.every(event => event.target === 'publisherC')).equals(true)
  })

  it('switches the iPhone at 20, 40, 60, 80 and 100 min, never in a cut slot', function () {
    const { events, cuts } = soakSchedule()
    const switches = events.filter(event => event.action === 'switchSurface')
    expect(
      switches.map(event => [
        event.atSec / MIN,
        event.args.to,
        event.args.newTab
      ])
    ).deep.equals([
      [20, 'safari', true],
      [40, 'app', false],
      [60, 'safari', false],
      [80, 'app', false],
      [100, 'safari', false]
    ])
    const cutSlots = new Set(cuts.map(cut => cut.atSec))
    expect(switches.filter(event => cutSlots.has(event.atSec))).deep.equals([])
  })

  it('acts on the iPhone surface that is in front', function () {
    const schedule = soakSchedule()
    for (const event of schedule.events) {
      if (event.target === 'iphone-app' || event.target === 'iphone-safari') {
        if (event.action === 'join') continue
        expect(
          `iphone-${iphoneFrontAt(schedule.switches, event.atSec)}`
        ).equals(event.target)
      }
    }
    expect(iphoneFrontAt(schedule.switches, 0)).equals('app')
    expect(iphoneFrontAt(schedule.switches, 115 * MIN)).equals('safari')
  })

  it('never schedules a rejoin while a cut or its recovery is under way', function () {
    for (const schedule of [soakSchedule(), soakSchedule({ minutes: 15 })]) {
      for (const cut of schedule.cuts) {
        const overlapping = schedule.events.filter(
          event =>
            (event.action === 'exitAndReenter' ||
              event.action === 'relaunch') &&
            event.atSec >= cut.atSec &&
            event.atSec < cut.atSec + cut.seconds + OUTAGE_RECOVERY_SEC
        )
        expect(overlapping).deep.equals([])
      }
    }
  })

  it('gives each kind its arguments', function () {
    const { events } = soakSchedule()
    const first = (kind: string): Record<string, unknown> =>
      events.find(event => event.action === kind)!.args
    const left = first('scrubLeft').fraction as number
    expect(left).gte(0.2).lte(0.6)
    expect(first('scrubRight')).deep.equals({ fraction: 1 })
    expect(first('rapidScrub').fractions).length(5)
    expect(first('skip')).deep.equals({ steps: [-10, -10, -10, 10, 10] })
    expect(first('slowMotion')).deep.equals({ holdMs: 8000 })
    expect(first('cameraCut').backAfterSec).equals(20)
    expect(['Phone A', 'Phone B', 'Synthetic']).includes(
      first('cameraCut').angle
    )
    expect(first('exitAndReenter')).deep.equals({ waitSec: 10 })
    expect(first('relaunch')).deep.equals({})
    expect(first('jumpToPresent')).deep.equals({})
  })

  describe('compressed for a dry run', function () {
    it('has every surface do every kind once, cuts C twice and switches app → Safari → app', function () {
      const schedule = soakSchedule({ minutes: 15 })
      expect(schedule.layout).equals('compressed')
      expect(schedule.lengthSec).equals(900)
      const counts = kindCounts(schedule)
      for (const surface of SURFACES) {
        for (const kind of ACTION_KINDS) {
          expect(counts[surface][kind], `${surface} ${kind}`).equals(1)
        }
      }
      expect(
        schedule.cuts.map(cut => [cut.seconds, cut.discontinuity])
      ).deep.equals([
        [FULL_CUTS[0].seconds, false],
        [30, true]
      ])
      expect(schedule.switches.map(change => change.to)).deep.equals([
        'safari',
        'app'
      ])
      const seconds = schedule.events.map(event => event.atSec)
      expect(new Set(seconds).size).equals(seconds.length)
      expect(schedule.events.at(-1)!.atSec).equals(900)
      expect(schedule.slotSec).gte(5).lt(30)
    })

    it('lays its phases inside the run', function () {
      const { phases, lengthSec } = soakSchedule({ minutes: 15 })
      expect(phases.actions[0]).equals(360)
      expect(phases.quiet).deep.equals([840, lengthSec])
      expect(phases.finalWindow[1]).equals(lengthSec)
    })

    it('takes its length in seconds too, and refuses one too short or too long', function () {
      expect(soakSchedule({ lengthSec: 1200 }).layout).equals('compressed')
      expect(() => soakSchedule({ lengthSec: MIN_COMPRESSED_SEC - 1 })).throws(
        /at least/
      )
      expect(() => soakSchedule({ minutes: 121 })).throws(/at most/)
      expect(() => soakSchedule({ lengthSec: Number.NaN })).throws(/at most/)
    })
  })

  it('reads SOAK_MINUTES', function () {
    expect(minutesFromEnv({})).equals(undefined)
    expect(minutesFromEnv({ SOAK_MINUTES: ' ' })).equals(undefined)
    expect(minutesFromEnv({ SOAK_MINUTES: '15' })).equals(15)
    expect(() => minutesFromEnv({ SOAK_MINUTES: 'x' })).throws(/SOAK_MINUTES/)
    expect(() => minutesFromEnv({ SOAK_MINUTES: '0' })).throws(/SOAK_MINUTES/)
  })
})
