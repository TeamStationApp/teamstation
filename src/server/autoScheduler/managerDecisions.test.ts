import { expect } from 'chai'
import { describe, it } from 'mocha'

import { withQueryReplies } from '../../test/queryReplies'
import { teamHeadCoach } from '../teams/teamHeadCoach'
import { occupancy } from '../venues/occupancy'
import { headCoachesOf } from './snapshot'

describe('manager identity and booking decisions', () => {
  it('displays an alias grant with the current account’s public name', async () => {
    await withQueryReplies(
      [
        ['from "scope_roles"', [{ user_id: 'alias' }]],
        [
          'with recursive up(',
          [
            { start: 'alias', survivor: 'coach', id: 'coach' },
            { start: 'alias', survivor: 'coach', id: 'alias' }
          ]
        ],
        [
          'from "users"',
          [{ displayName: '', firstName: 'Miguel', lastName: 'Cabrera' }]
        ]
      ],
      async db => {
        expect(await teamHeadCoach(db, 'team')).deep.equals({
          grantUserId: 'alias',
          userId: 'coach',
          name: 'Miguel C.'
        })
      }
    )
    await withQueryReplies([['from "scope_roles"', []]], async db => {
      expect(await teamHeadCoach(db, 'vacant')).equals(undefined)
    })
  })

  it('matches managers across leagues through the survivor and skips unresolved identities', async () => {
    await withQueryReplies(
      [
        ['from "scope_roles"', [{ scope_id: 'local', user_id: 'alias' }]],
        ['with recursive chain', [{ startId: 'alias', survivorId: 'coach' }]],
        [
          'from "users"',
          [{ id: 'coach' }],
          query => {
            expect(query.sql).includes('"disabled_at" is null')
            expect(query.sql).includes('"login_enabled" =')
          }
        ],
        ['with recursive closed', [{ id: 'coach' }, { id: 'alias' }]],
        [
          'from "scope_roles"',
          [
            { scope_id: 'local', user_id: 'alias' },
            { scope_id: 'outside', user_id: 'coach' },
            { scope_id: 'broken', user_id: 'loop' }
          ]
        ],
        [
          'with recursive chain',
          [
            { startId: 'alias', survivorId: 'coach' },
            { startId: 'coach', survivorId: 'coach' }
          ]
        ]
      ],
      async db => {
        expect(await headCoachesOf(db, ['local'])).deep.equals({
          local: 'coach',
          outside: 'coach'
        })
      }
    )
    await withQueryReplies([['from "scope_roles"', []]], async db => {
      expect(await headCoachesOf(db, [])).deep.equals({})
      expect(await headCoachesOf(db, ['vacant'])).deep.equals({})
    })
  })

  it('retains both outstanding proposals and the original time in either proposal order', async () => {
    const start = (day: number): Date => new Date(Date.UTC(2030, 0, day, 10))
    const end = (day: number): Date => new Date(Date.UTC(2030, 0, day, 11))
    const pending = (day: number): { terms: unknown } => ({
      terms: {
        gameId: 'game',
        game: {
          homeTeamId: 'external',
          awayTeamId: 'visitor',
          startAt: start(day).toISOString(),
          endAt: end(day).toISOString(),
          status: 'scheduled'
        }
      }
    })
    for (const days of [
      [2, 3],
      [3, 2]
    ]) {
      await withQueryReplies(
        [
          [
            'from "games"',
            [
              {
                id: 'game',
                home_team_id: 'external',
                away_team_id: 'visitor',
                start_at: start(1),
                end_at: end(1),
                field_id: 'old',
                season_id: 'outside'
              }
            ]
          ],
          ['from "group_requests"', days.map(pending)]
        ],
        async db => {
          const bookings = await occupancy(
            db,
            { teamIds: ['external'], keepScheduledFor: ['external'] },
            { now: () => start(1) }
          )
          expect(bookings.map(b => b.start)).deep.equals(
            [1, 2, 3].map(day => start(day).getTime())
          )
          expect(
            bookings.filter(b => b.managerOnly === true).map(b => b.start)
          ).to.have.members([start(1).getTime(), start(days[0]).getTime()])
          expect(bookings.every(b => b.key === 'game')).equals(true)
        }
      )
    }
  })
})
