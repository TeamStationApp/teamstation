import { setTimeout } from 'node:timers/promises'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import {
  asTeamPlayersBody,
  TEAM_MEMBERS_MAX,
  type TeamPlayersResponse
} from '../../common/teamMembers'
import { scratchDatabase } from '../../test/scoreboardKit'
import { mergeTeams } from '../admin/mergeTeams'
import type { Database } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { insertUser } from '../users/insertUser'
import { addPlayers } from './addPlayers'

/** Settles `promise`, or says it did not within `ms`. */
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return await Promise.race([
    promise,
    setTimeout(ms).then(() => {
      throw new Error(`Still waiting after ${ms} ms`)
    })
  ])
}

/** One outside scorer's play, naming nobody by id. */
const onePlay = (batter: string): ReturnType<typeof asPostEventsBody> =>
  asPostEventsBody({
    mode: 'replace',
    source: { system: 'acme' },
    plays: [
      {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'single', awayScore: 0, homeScore: 0 },
        matchup: { batter: { fullName: batter } }
      }
    ]
  })

/**
 * A whole import of new players, as `POST /teams/:teamId/players` sends
 * the most a call takes, held open after its `pauseAt`th membership insert
 * until released.
 */
interface HeldImport {
  done: Promise<TeamPlayersResponse>
  paused: Promise<void>
  release: () => void
}

describe('a team’s import of a full roster of new players', function () {
  this.timeout(120_000)
  let db: Kysely<Database>
  let drop: () => Promise<void>
  let admin: string
  let imports = 0

  before(async function () {
    ;({ db, drop } = await scratchDatabase('addplayers'))
    admin = await insertUser(db, {
      display_name: 'Import Admin',
      is_admin: true
    })
  })
  after(async function () {
    await drop?.()
  })

  const team = async (name: string): Promise<string> => {
    const id = makeId('team')
    await db
      .insertInto('teams')
      .values({ id, name, kind: 'external' })
      .execute()
    return id
  }
  const person = async (name: string): Promise<string> =>
    await insertUser(db, { display_name: name, first_name: name })
  const member = async (teamId: string, userId: string): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: teamId,
        user_id: userId,
        is_player: true
      })
      .execute()
  }
  const game = async (home: string, away: string): Promise<string> => {
    const id = makeId('game')
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    return id
  }
  const rows = (
    count: number
  ): ReturnType<typeof asTeamPlayersBody>['players'] => {
    imports += 1
    const run = imports
    return asTeamPlayersBody({
      players: Array.from({ length: count }, (_, n) => ({
        externalId: { system: 'locks', kind: 'person', id: `${run}_${n}` },
        firstName: `Player${n}`,
        lastName: `Import${run}`,
        jersey: String(n % 100)
      }))
    }).players
  }
  const heldImport = (teamId: string, pauseAt: number): HeldImport => {
    let release = (): void => {}
    let reached = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const paused = new Promise<void>(resolve => {
      reached = resolve
    })
    const inserts = new Set<unknown>()
    let seen = 0
    const done = addPlayers(
      db.withPlugin({
        transformQuery(args) {
          if (
            args.node.kind === 'InsertQueryNode' &&
            JSON.stringify(args.node.into).includes('"memberships"')
          )
            inserts.add(args.queryId)
          return args.node
        },
        async transformResult(args) {
          if (inserts.has(args.queryId)) {
            seen += 1
            if (seen === pauseAt) {
              reached()
              await barrier
            }
          }
          return args.result
        }
      }),
      { userId: admin, isAdmin: true, scopes: [] },
      teamId,
      rows(TEAM_MEMBERS_MAX)
    )
    done.catch(() => undefined)
    return { done, paused, release }
  }
  const created = (answer: TeamPlayersResponse): void => {
    expect(answer.counts).deep.equals({
      created: TEAM_MEMBERS_MAX,
      joined: 0,
      unchanged: 0,
      error: 0
    })
  }

  it('holds up no membership write, rename or post of another team while it is open', async () => {
    const teamA = await team('Import A')
    const teamC = await team('Import C')
    const onC = await person('On C')
    const joining = await person('Joining C')
    await member(teamC, onC)
    const gameC = await game(teamC, await team('Import D'))
    // Every row in, the import's transaction still open.
    const held = heldImport(teamA, TEAM_MEMBERS_MAX)
    try {
      await within(held.paused, 60_000)
      await within(
        db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            team_id: teamC,
            user_id: joining,
            role: 'manager'
          })
          .execute()
      )
      await within(
        db
          .updateTable('users')
          .set({ display_name: 'Renamed On C' })
          .where('id', '=', onC)
          .execute()
      )
      const added = await within(
        addPlayers(
          db,
          { userId: admin, isAdmin: true, scopes: [] },
          teamC,
          rows(1)
        )
      )
      expect(added.counts.created).equals(1)
      await within(postGamePlays(db, gameC, onePlay('Batter C')))
      held.release()
      created(await within(held.done, 60_000))
    } finally {
      held.release()
      await Promise.allSettled([held.done])
    }
  })

  it('runs two at once on two teams to the end, neither aborted as a deadlock', async () => {
    const one = heldImport(await team('Import One'), 100)
    const two = heldImport(await team('Import Two'), 100)
    try {
      // Both halfway, then both on together.
      await within(Promise.all([one.paused, two.paused]), 60_000)
      one.release()
      two.release()
      const [first, second] = await within(
        Promise.allSettled([one.done, two.done]),
        60_000
      )
      expect(
        first.status,
        String((first as PromiseRejectedResult).reason)
      ).equals('fulfilled')
      expect(
        second.status,
        String((second as PromiseRejectedResult).reason)
      ).equals('fulfilled')
      created((first as PromiseFulfilledResult<TeamPlayersResponse>).value)
      created((second as PromiseFulfilledResult<TeamPlayersResponse>).value)
    } finally {
      one.release()
      two.release()
      await Promise.allSettled([one.done, two.done])
    }
  })

  it('and a merge of two other teams wait for neither', async () => {
    const teamA = await team('Import Beside Merge')
    const from = await team('Merge From')
    const into = await team('Merge Into')
    await member(from, await person('On From'))
    await member(into, await person('On Into'))
    const gameOfFrom = await game(from, await team('Merge Opponent'))
    // A play for the merge to move, where it is held below.
    await db
      .insertInto('events')
      .values({
        id: makeId('event'),
        gameId: gameOfFrom,
        battingTeamId: from,
        source: 'external',
        gumbo: onePlay('Before').plays[0]
      })
      .execute()
    const imported = heldImport(teamA, TEAM_MEMBERS_MAX)
    let release = (): void => {}
    let reached = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const paused = new Promise<void>(resolve => {
      reached = resolve
    })
    const updates = new Set<unknown>()
    let merge: Promise<unknown> | undefined
    try {
      await within(imported.paused, 60_000)
      // The merge moves both teams' memberships while the import is open,
      // and is held after them, at its plays.
      merge = mergeTeams(
        db.withPlugin({
          transformQuery(args) {
            if (JSON.stringify(args.node).includes('update events set'))
              updates.add(args.queryId)
            return args.node
          },
          async transformResult(args) {
            if (updates.has(args.queryId)) {
              reached()
              await barrier
            }
            return args.result
          }
        }),
        { fromTeamId: from, intoTeamId: into, apply: true }
      )
      merge.catch(() => undefined)
      await within(paused)
      imported.release()
      created(await within(imported.done, 60_000))
      release()
      expect(await within(merge)).includes({ applied: true })
    } finally {
      imported.release()
      release()
      await Promise.allSettled([imported.done, merge])
    }
  })
})
