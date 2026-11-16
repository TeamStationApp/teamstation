import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { makeId } from '../../common/ids'
import { teamsOfRow } from '../../common/teamLists'
import {
  addGame,
  addPerson,
  addTeam,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { lineupRoutes } from '../routes/lineups'
import { ensureExternalGuests, type ExternalGuest } from './externalGuests'

/**
 * An outside scorer's players who have no account each become one guest
 * account, made once under the scorer's id for them and reused for every
 * game they play, seated as a guest of the side they play on.
 */

const outside = (id: string): ExternalGuest['externalId'] => ({
  system: 'outsideScorer',
  kind: 'player',
  id
})

describe('guests for an outside scorer’s players', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let home = ''
  let away = ''
  let admin: Actor
  let stranger: Actor

  before(async function () {
    ;({ db, drop } = await scratchDatabase('external_guests'))
    home = await addTeam(db, 'Hosts')
    away = await addTeam(db, 'Visitors')
    admin = {
      userId: (await addPerson(db, 'admin', { isAdmin: true })).userId,
      isAdmin: true,
      scopes: []
    }
    stranger = {
      userId: (await addPerson(db, 'stranger')).userId,
      isAdmin: false,
      scopes: []
    }
  })

  after(async function () {
    await drop()
  })

  async function finalGame(): Promise<string> {
    return await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date('2026-05-02T18:00:00.000Z'),
      status: 'final'
    })
  }

  async function guestsOf(gameId: string): Promise<Record<string, number[]>> {
    const game = await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    return storedGuests(game.guests, teamsOfRow(game))
  }

  const three: ExternalGuest[] = [
    {
      side: 'away',
      externalId: outside('ext-a1'),
      firstName: 'Ada',
      lastName: 'One',
      jersey: '1'
    },
    {
      side: 'away',
      externalId: outside('ext-a2'),
      firstName: 'Bo',
      lastName: 'Two',
      jersey: '2'
    },
    {
      side: 'home',
      externalId: outside('ext-h1'),
      firstName: 'Cy',
      lastName: 'Three',
      jersey: '3'
    }
  ]

  it('makes one account each that cannot sign in, and seats it on its side', async function () {
    const gameId = await finalGame()
    const answers = await ensureExternalGuests(db, admin, gameId, three)
    expect(answers.map(answer => answer.created)).deep.equals([
      true,
      true,
      true
    ])
    const guests = await guestsOf(gameId)
    expect(guests.away).members([answers[0].gumboId, answers[1].gumboId])
    expect(guests.home).members([answers[2].gumboId])
    const users = await db
      .selectFrom('users')
      .select(['id', 'login_enabled', 'first_name'])
      .where(
        'id',
        'in',
        answers.map(answer => answer.userId!)
      )
      .execute()
    expect(users.every(user => !user.login_enabled)).equals(true)
    const held = await db
      .selectFrom('external_ids')
      .select(['external_id', 'entity_id'])
      .where('system', '=', 'outsideScorer')
      .where('external_id', 'in', ['ext-a1', 'ext-a2', 'ext-h1'])
      .execute()
    expect(held).length(3)
    // Again: nothing new, the same accounts.
    const again = await ensureExternalGuests(db, admin, gameId, three)
    expect(again.map(answer => answer.created)).deep.equals([
      false,
      false,
      false
    ])
    expect(again.map(answer => answer.userId)).deep.equals(
      answers.map(answer => answer.userId)
    )
    expect(await guestsOf(gameId)).deep.equals(guests)
  })

  it('reuses a player across games, and refuses him for the other side', async function () {
    const first = await finalGame()
    const [made] = await ensureExternalGuests(db, admin, first, [three[0]])
    const second = await finalGame()
    const [reused] = await ensureExternalGuests(db, admin, second, [three[0]])
    expect(reused).include({ created: false, userId: made.userId })
    const [refused] = await ensureExternalGuests(db, admin, second, [
      { ...three[0], side: 'home' }
    ])
    expect(refused.refused).match(/other side/)
    expect((await guestsOf(second)).home).not.include(made.gumboId)
  })

  it('does not seat as a guest somebody already on the side’s roster', async function () {
    const gameId = await finalGame()
    const rostered = await addPerson(db, 'rostered')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: away,
        user_id: rostered.userId,
        role: 'member',
        is_player: true
      })
      .execute()
    await db
      .insertInto('external_ids')
      .values({
        id: `ext_${rostered.gumboId}`,
        entity_type: 'user',
        entity_id: rostered.userId,
        system: 'outsideScorer',
        kind: 'player',
        external_id: 'ext-rostered'
      })
      .execute()
    const [answer] = await ensureExternalGuests(db, admin, gameId, [
      {
        side: 'away',
        externalId: outside('ext-rostered'),
        firstName: 'R',
        lastName: 'R',
        jersey: '9'
      }
    ])
    expect(answer).include({ created: false, userId: rostered.userId })
    expect((await guestsOf(gameId)).away).not.include(answer.gumboId)
  })

  it('refuses a caller with no role on either team', async function () {
    const gameId = await finalGame()
    const error = await ensureExternalGuests(db, stranger, gameId, three).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).instanceOf(HttpError)
    expect((error as HttpError).status).equals(403)
  })

  it('names a guest whose names are only spaces "Player"', async function () {
    const gameId = await finalGame()
    const [answer] = await ensureExternalGuests(db, admin, gameId, [
      {
        ...three[0],
        externalId: outside('ext-blank'),
        firstName: '  ',
        lastName: ' '
      }
    ])
    const user = await db
      .selectFrom('users')
      .select(['display_name', 'first_name', 'last_name'])
      .where('id', '=', answer.userId!)
      .executeTakeFirstOrThrow()
    expect(user).deep.equals({
      display_name: 'Player',
      first_name: null,
      last_name: null
    })
  })

  it('refuses, and does not name, an account somebody else made', async function () {
    const gameId = await finalGame()
    // A child on another team's roster, whose outside scorer's id is recorded.
    const elsewhere = await addTeam(db, 'Elsewhere')
    const child = await addPerson(db, 'child')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: elsewhere,
        user_id: child.userId,
        role: 'member',
        is_player: true
      })
      .execute()
    await db
      .insertInto('external_ids')
      .values({
        id: 'ext_child',
        entity_type: 'user',
        entity_id: child.userId,
        system: 'outsideScorer',
        kind: 'player',
        external_id: 'ext-child'
      })
      .execute()
    const [answer] = await ensureExternalGuests(db, admin, gameId, [
      { ...three[0], externalId: outside('ext-child') }
    ])
    expect(answer).deep.equals({
      externalId: outside('ext-child'),
      created: false,
      refused: 'That external id is a player this route does not seat'
    })
    expect((await guestsOf(gameId)).away).not.include(child.gumboId)
  })

  it('refuses a guest the game’s plays name for the other side', async function () {
    const first = await finalGame()
    const [made] = await ensureExternalGuests(db, admin, first, [
      { ...three[2], externalId: outside('ext-switch') }
    ])
    // A later game whose play names him batting for the home side.
    const later = await finalGame()
    const eventId = makeId('event')
    await db
      .insertInto('events')
      .values({
        id: eventId,
        gameId: later,
        gumbo: JSON.stringify({ about: { atBatIndex: 0 } })
      })
      .execute()
    await db
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: eventId,
        gumbo_id: made.gumboId!,
        team_id: home,
        role: 'batter',
        position: null
      })
      .execute()
    const [answer] = await ensureExternalGuests(db, admin, later, [
      { ...three[0], externalId: outside('ext-switch') }
    ])
    expect(answer.refused).match(/other side/)
    expect(answer.userId).equals(undefined)
  })

  it('takes over an id its removed account left behind', async function () {
    const gameId = await finalGame()
    // The account that held the id is gone; its row was left.
    const gone = (await addPerson(db, 'gone')).userId
    await db
      .insertInto('external_ids')
      .values({
        id: 'ext_orphan',
        entity_type: 'user',
        entity_id: gone,
        system: 'outsideScorer',
        kind: 'player',
        external_id: 'ext-orphan'
      })
      .execute()
    await db.deleteFrom('gumbo_ids').where('user_id', '=', gone).execute()
    await db.deleteFrom('users').where('id', '=', gone).execute()
    const [answer] = await ensureExternalGuests(db, admin, gameId, [
      { ...three[0], externalId: outside('ext-orphan') }
    ])
    expect(answer).include({ created: true })
    expect(answer.refused).equals(undefined)
    const row = await db
      .selectFrom('external_ids')
      .select('entity_id')
      .where('id', '=', 'ext_orphan')
      .executeTakeFirstOrThrow()
    expect(row.entity_id).equals(answer.userId)
  })

  it('answers over its route, and refuses an id that names something else', async function () {
    const gameId = await finalGame()
    // The same outside id already names a team, not a player.
    await db
      .insertInto('external_ids')
      .values({
        id: 'ext_taken',
        entity_type: 'team',
        entity_id: home,
        system: 'outsideScorer',
        kind: 'player',
        external_id: 'ext-taken'
      })
      .execute()
    const caller = await addPerson(db, 'routeAdmin', { isAdmin: true })
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', caller.userId)
      .execute()
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', lineupRoutes(db))
    app.use(errorHandler)
    const server = app.listen(0)
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch(
        `http://127.0.0.1:${port}/api/v1/games/${gameId}/guests/external`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${caller.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            guests: [
              three[2],
              { ...three[2], externalId: outside('ext-taken'), jersey: '7' }
            ]
          })
        }
      )
      expect(res.status).equals(200)
      const body = (await res.json()) as {
        guests: Array<{ created: boolean; refused?: string }>
      }
      expect(body.guests[0].refused).equals(undefined)
      expect(body.guests[1]).deep.equals({
        externalId: outside('ext-taken'),
        created: false,
        refused: 'That external id names something else'
      })
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })
})
