import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import type { Database } from '../db/database'
import {
  daysOut,
  daysOutText,
  DEFAULT_LEAGUE_ZONE,
  digestDue,
  type DigestGame,
  digestLine,
  digestTitle,
  joinWords,
  type LeagueNoticePush,
  leagueZone,
  noticeSettingsChange,
  noticeUrl,
  queueUmpireDigests,
  signUpText,
  startUmpireDigests,
  withdrawText
} from './notices'

const at = (iso: string): Date => new Date(iso)

function refusal(body: unknown): string {
  try {
    noticeSettingsChange(body)
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) return error.message
    throw error
  }
  throw new Error('expected a 400')
}

describe('umpire notices', function () {
  describe('the league’s zone', function () {
    it('is the locality’s, when Intl knows it', function () {
      expect(
        leagueZone({
          city: 'Albany',
          region: 'NY',
          country: 'US',
          placeId: null,
          timezone: 'America/New_York'
        })
      ).equals('America/New_York')
    })

    it('is Pacific with no locality, no zone, or one Intl refuses', function () {
      expect(DEFAULT_LEAGUE_ZONE).equals('America/Los_Angeles')
      for (const locality of [
        null,
        undefined,
        'America/New_York',
        {},
        { timezone: '' },
        { timezone: 7 },
        { timezone: 'Mars/Olympus_Mons' }
      ])
        expect(leagueZone(locality)).equals('America/Los_Angeles')
    })
  })

  describe('when the day’s digest is due', function () {
    // Each pair is 09:59 and 10:00 local on a day either side of a change.
    const days: Array<[string, string, string]> = [
      // New York: EST before 14 March 2027, EDT from it.
      ['America/New_York', '2027-03-13T14:59:00Z', '2027-03-13T15:00:00Z'],
      ['America/New_York', '2027-03-14T13:59:00Z', '2027-03-14T14:00:00Z'],
      // EDT before 7 November 2027, EST from it.
      ['America/New_York', '2027-11-06T13:59:00Z', '2027-11-06T14:00:00Z'],
      ['America/New_York', '2027-11-07T14:59:00Z', '2027-11-07T15:00:00Z'],
      // Auckland: NZDT (+13) until 4 April 2027, NZST (+12) after.
      ['Pacific/Auckland', '2027-04-02T20:59:00Z', '2027-04-02T21:00:00Z'],
      ['Pacific/Auckland', '2027-04-04T21:59:00Z', '2027-04-04T22:00:00Z'],
      // NZST until 26 September 2027, NZDT from it.
      ['Pacific/Auckland', '2027-09-24T21:59:00Z', '2027-09-24T22:00:00Z'],
      ['Pacific/Auckland', '2027-09-26T20:59:00Z', '2027-09-26T21:00:00Z']
    ]
    for (const [zone, before, from] of days)
      it(`is not at 09:59 and is at 10:00 in ${zone}, ${from}`, function () {
        expect(digestDue(at(before), zone)).equals(false)
        expect(digestDue(at(from), zone)).equals(true)
      })

    it('stays due the rest of the local day, and not before 10:00 the next', function () {
      expect(digestDue(at('2027-03-14T04:59:00Z'), 'America/New_York')).equals(
        true
      )
      expect(digestDue(at('2027-03-14T05:00:00Z'), 'America/New_York')).equals(
        false
      )
    })
  })

  describe('days out', function () {
    it('counts calendar days in the game’s zone across a daylight-saving change', function () {
      // 10:00 EST on 13 March; 20:30 EDT on the 14th, a 23-hour day between.
      expect(
        daysOut(
          at('2027-03-13T15:00:00Z'),
          at('2027-03-15T00:30:00Z'),
          'America/New_York'
        )
      ).equals(1)
      // 10:00 EDT on 6 November; 08:00 EST on the 7th, a 25-hour day.
      expect(
        daysOut(
          at('2027-11-06T14:00:00Z'),
          at('2027-11-07T13:00:00Z'),
          'America/New_York'
        )
      ).equals(1)
      expect(
        daysOut(
          at('2027-11-06T14:00:00Z'),
          at('2027-11-06T23:00:00Z'),
          'America/New_York'
        )
      ).equals(0)
    })

    it('reads the zone it is given, so a game is counted in its own, not its league’s', function () {
      // 22:30 on 1 March in Los Angeles is 01:30 on the 2nd in New York; the
      // game is the evening of the 2nd in both.
      const now = at('2027-03-02T06:30:00Z')
      const start = at('2027-03-03T02:00:00Z')
      expect(daysOut(now, start, 'America/Los_Angeles')).equals(1)
      expect(daysOut(now, start, 'America/New_York')).equals(0)
    })

    it('dates and counts an away game in its own zone, not its season’s', function () {
      // 10:00 PDT on 18 April; the game is 11:30 pm on the 18th in Honolulu,
      // its own zone, and 5:30 am on the 19th in New York, its season's.
      const now = at('2027-04-18T17:00:00Z')
      const startAt = at('2027-04-19T09:30:00Z')
      expect(daysOut(now, startAt, 'Pacific/Honolulu')).equals(0)
      expect(daysOut(now, startAt, 'America/New_York')).equals(1)
      const away: DigestGame = {
        id: 'gam_away',
        home: 'Demo Eagles',
        away: 'Demo Visitors',
        startAt,
        seasonName: 'Demo Regular',
        zone: 'Pacific/Honolulu',
        venue: '',
        field: '',
        open: ['Plate'],
        daysOut: daysOut(now, startAt, 'Pacific/Honolulu')
      }
      expect(digestLine(away)).equals(
        'Demo Eagles vs Demo Visitors · Apr 18, 11:30 pm · Demo Regular — Plate (today)'
      )
      expect(signUpText('Jordan Ray', 'Plate', away)).equals(
        'Jordan Ray signed up as Plate for Demo Eagles vs Demo Visitors, Apr 18 11:30 pm'
      )
    })
  })

  describe('what the notices say', function () {
    const game: DigestGame = {
      id: 'gam_one',
      home: 'Demo Hawks',
      away: 'Demo Eagles',
      // 4:00 pm in Los Angeles.
      startAt: at('2027-03-03T00:00:00Z'),
      seasonName: 'Fall Minors',
      zone: 'America/Los_Angeles',
      venue: '',
      field: 'Field 1',
      open: ['Plate', 'Base'],
      daysOut: 3
    }

    it('titles the digest by how many games it lists', function () {
      expect(digestTitle(1)).equals('1 game still needs umpires')
      expect(digestTitle(2)).equals('2 games still need umpires')
      expect(digestTitle(12)).equals('12 games still need umpires')
    })

    it('says one line a game: teams, time in the game’s zone, season, place, positions and days out', function () {
      expect(digestLine(game)).equals(
        'Demo Hawks vs Demo Eagles · Mar 2, 4:00 pm · Fall Minors · Field 1 — Plate and Base (3 days out)'
      )
      expect(
        digestLine({
          ...game,
          venue: 'Memorial Park',
          open: ['Plate'],
          daysOut: 0
        })
      ).equals(
        'Demo Hawks vs Demo Eagles · Mar 2, 4:00 pm · Fall Minors · Memorial Park, Field 1 — Plate (today)'
      )
      expect(
        digestLine({
          ...game,
          field: '',
          open: ['Plate', 'Base', 'Field'],
          daysOut: 1,
          zone: 'America/New_York'
        })
      ).equals(
        'Demo Hawks vs Demo Eagles · Mar 2, 7:00 pm · Fall Minors — Plate, Base and Field (1 day out)'
      )
    })

    it('joins positions with commas and “and”', function () {
      expect(joinWords([])).equals('')
      expect(joinWords(['Plate'])).equals('Plate')
      expect(joinWords(['Plate', 'Base'])).equals('Plate and Base')
      expect(joinWords(['Plate', 'Base', 'Field'])).equals(
        'Plate, Base and Field'
      )
      expect(daysOutText(0)).equals('today')
      expect(daysOutText(1)).equals('1 day out')
      expect(daysOutText(5)).equals('5 days out')
    })

    it('says who signed up or withdrew, as what, and for which game', function () {
      expect(signUpText('Jordan Ray', 'Plate', game)).equals(
        'Jordan Ray signed up as Plate for Demo Hawks vs Demo Eagles, Mar 2 4:00 pm'
      )
      expect(withdrawText('Jordan Ray', 'Plate', game)).equals(
        'Jordan Ray withdrew from Plate for Demo Hawks vs Demo Eagles, Mar 2 4:00 pm'
      )
    })

    it('opens the league’s umpire schedule on the game', function () {
      expect(noticeUrl('lea_one', 'gam_one')).equals(
        'teamstation://umpires/lea_one?view=league&game=gam_one'
      )
    })
  })

  describe('a settings change', function () {
    it('takes any of the four settings', function () {
      expect(noticeSettingsChange({})).deep.equals({})
      expect(
        noticeSettingsChange({
          missingSlots: true,
          daysBefore: 30,
          signUps: false,
          withdrawals: true
        })
      ).deep.equals({
        missingSlots: true,
        daysBefore: 30,
        signUps: false,
        withdrawals: true
      })
      expect(noticeSettingsChange({ daysBefore: 1 })).deep.equals({
        daysBefore: 1
      })
    })

    it('refuses days outside 1–30 or not whole, toggles that are not booleans, and anything else', function () {
      for (const daysBefore of [0, 31, 2.5, '7', null])
        expect(refusal({ daysBefore })).equals(
          'daysBefore must be a whole number from 1 to 30'
        )
      expect(refusal({ signUps: 'yes' })).equals(
        'signUps must be true or false'
      )
      expect(refusal({ sort: [] })).equals(
        'Unknown umpire notification setting sort'
      )
      for (const body of [null, [], 'on'])
        expect(refusal(body)).equals('Supply umpire notification settings')
    })
  })

  describe('the digest sweep', function () {
    // Never read: each test's `record` stands in for the database.
    const db = {} as unknown as Kysely<Database>
    const push = (id: string): LeagueNoticePush => ({
      t: 'league',
      u: ['usr_admin'],
      title: 'Demo League',
      body: '1 game still needs umpires',
      url: noticeUrl('lea_demo', 'gam_one'),
      tag: `event:league:${id}`
    })
    const settle = async (): Promise<void> => {
      await new Promise(resolve => setImmediate(resolve))
    }

    it('queues each digest recorded at that moment, counting only what the queue took', async function () {
      const now = at('2026-03-02T15:00:00Z')
      const asked: Date[] = []
      const added: unknown[] = []
      const said: string[] = []
      const queued = await queueUmpireDigests(
        db,
        now,
        {
          add: async request => {
            added.push(request)
            return added.length === 1
          }
        },
        line => said.push(line),
        async (given, when, sweep) => {
          expect(given).equals(db)
          asked.push(when!)
          // Each push is handed on as its digest is recorded.
          await sweep!.push!(push('one'))
          expect(added).has.length(1)
          await sweep!.push!(push('two'))
          return [push('one'), push('two')]
        }
      )
      expect(asked).deep.equals([now])
      expect(
        added.map(request => (request as LeagueNoticePush).tag)
      ).deep.equals(['event:league:one', 'event:league:two'])
      expect(queued).equals(1)
      expect(said).deep.equals([])
    })

    it('says a failed sweep and queues nothing, for the next sweep to try', async function () {
      const said: string[] = []
      const queued = await queueUmpireDigests(
        db,
        new Date(),
        {
          add: async () => {
            throw new Error('never asked')
          }
        },
        line => said.push(line),
        async () => {
          throw new Error('database away')
        }
      )
      expect(queued).equals(0)
      expect(said).deep.equals([
        'recording umpire digests: Error: database away'
      ])
    })

    it('keeps the pushes queued before a sweep fails, and says a push the queue refused', async function () {
      const added: string[] = []
      const said: string[] = []
      const queued = await queueUmpireDigests(
        db,
        new Date(),
        {
          add: async request => {
            const { tag } = request as LeagueNoticePush
            if (tag === 'event:league:refused') throw new Error('queue away')
            added.push(tag)
            return true
          }
        },
        line => said.push(line),
        async (_given, _when, sweep) => {
          await sweep!.push!(push('one'))
          await sweep!.push!(push('refused'))
          await sweep!.push!(push('two'))
          sweep!.log!('recording umpire digests for league lea_b: Error: x')
          throw new Error('database away')
        }
      )
      expect(added).deep.equals(['event:league:one', 'event:league:two'])
      expect(queued).equals(2)
      expect(said).deep.equals([
        'queueing event:league:refused: Error: queue away',
        'recording umpire digests for league lea_b: Error: x',
        'recording umpire digests: Error: database away'
      ])
    })

    it('sweeps once the queue is ready, and stops its timer and queue', async function () {
      const added: unknown[] = []
      let ready: (() => void) | undefined
      let closed = 0
      let sweeps = 0
      const job = startUmpireDigests(
        db,
        {
          add: async request => {
            added.push(request)
            return true
          },
          whenReady: then => {
            ready = then
          },
          close: async () => {
            closed++
          }
        },
        () => undefined,
        async (_given, _when, sweep) => {
          sweeps++
          await sweep!.push!(push('ready'))
          return [push('ready')]
        }
      )
      try {
        await settle()
        expect(sweeps).equals(0)
        ready?.()
        await settle()
        expect(sweeps).equals(1)
        expect(
          added.map(request => (request as LeagueNoticePush).tag)
        ).deep.equals(['event:league:ready'])
      } finally {
        await job.stop()
      }
      expect(closed).equals(1)
    })
  })
})
