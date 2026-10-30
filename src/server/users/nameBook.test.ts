import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { statsDatabase } from '../../test/statsDatabase'
import { closeInto } from '../admin/people'
import {
  booksOver,
  gameNames,
  gameNamesDigest,
  nameHalves,
  teamNames,
  userNames
} from './nameBook'

describe('name books', function () {
  this.timeout(60000)
  const fixture = statsDatabase('namebook')
  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const one = mintUserId(id => taken.has(id))
    taken.add(one.userId)
    return one
  }
  const people = {
    jordanPujols: mint(),
    jordanPerez: mint(),
    babe: mint(),
    imported: mint(),
    closing: mint(),
    keeping: mint()
  }
  before(async () => {
    const row = (
      who: { userId: number; legacyId: string },
      display: string,
      first: string | null,
      last: string | null
    ): Parameters<typeof insertFixtureUsers>[1] => ({
      id: who.userId,
      legacyId: who.legacyId,
      display_name: display,
      first_name: first,
      last_name: last,
      login_enabled: false
    })
    for (const made of [
      row(people.jordanPujols, 'Jordan Pujols', 'Jordan', 'Pujols'),
      row(people.jordanPerez, 'Jordan Perez', 'Jordan', 'Perez'),
      row(people.babe, 'Babe Ruth', 'Babe', 'Ruth'),
      row(people.imported, 'Cy Young Jr', null, null),
      row(people.closing, 'Hank Aaron', 'Hank', 'Aaron'),
      row(people.keeping, 'Henry Aaron', 'Henry', 'Aaron')
    ])
      await insertFixtureUsers(fixture.db, made)
    await closeInto(
      fixture.db,
      userIdOfGumbo(people.closing.userId),
      userIdOfGumbo(people.keeping.userId)
    )
  })

  it('computes short names over each scope, reading every scope in one query', async () => {
    let queries = 0
    const counted = fixture.db.withPlugin({
      transformQuery(args) {
        queries++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const books = await booksOver(
      counted,
      new Map([
        ['both', [people.jordanPujols.userId, people.jordanPerez.userId]],
        ['one', [people.jordanPujols.userId, people.babe.userId]]
      ])
    )
    // One for the people of every scope, and one for their teams' formats.
    expect(queries).equals(2)
    const both = books.get('both')!
    const one = books.get('one')!
    expect(both.nameOf(people.jordanPujols.userId)).equals('Jordan Pu')
    expect(both.nameOf(people.jordanPerez.userId)).equals('Jordan Pe')
    expect(one.nameOf(people.jordanPujols.userId)).equals('Jordan P')
    expect(one.nameOf(people.babe.userId)).equals('Babe R')
    // Only the scope's own people, and nobody unknown.
    expect(one.nameOf(people.jordanPerez.userId)).equals(undefined)
    expect(both.nameOf(1)).equals(undefined)
    expect(both.digest).not.equals(one.digest)
    expect((await booksOver(counted, new Map())).size).equals(0)
  })

  it('reads a merged account as its survivor', async () => {
    const book = (
      await booksOver(
        fixture.db,
        new Map([[0, [people.closing.userId, people.babe.userId]]])
      )
    ).get(0)!
    expect(book.nameOf(people.closing.userId)).equals('Henry A')
    expect(
      (await nameHalves(fixture.db, [people.closing.userId])).get(
        people.closing.userId
      )
    ).deep.equals({ firstName: 'Henry', lastName: 'Aaron' })
    expect(
      await userNames(fixture.db, [
        userIdOfGumbo(people.closing.userId),
        userIdOfGumbo(people.babe.userId)
      ])
    ).deep.equals(
      new Map([
        [userIdOfGumbo(people.closing.userId), 'Henry Aaron'],
        [userIdOfGumbo(people.babe.userId), 'Babe Ruth']
      ])
    )
    expect((await userNames(fixture.db, [])).size).equals(0)
  })

  it('answers halves as stored, or split from the display name', async () => {
    const halves = await nameHalves(fixture.db, [
      people.babe.userId,
      people.imported.userId
    ])
    expect(halves.get(people.babe.userId)).deep.equals({
      firstName: 'Babe',
      lastName: 'Ruth'
    })
    expect(halves.get(people.imported.userId)).deep.equals({
      firstName: 'Cy',
      lastName: 'Young Jr'
    })
    expect((await nameHalves(fixture.db, [])).size).equals(0)
  })

  it("names a team's people over its members", async () => {
    const team = makeId('team')
    await fixture.db
      .insertInto('teams')
      .values({ id: team, name: 'Owls' })
      .execute()
    await fixture.db
      .insertInto('memberships')
      .values(
        [people.jordanPujols, people.jordanPerez].map(person => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(person.userId),
          team_id: team
        }))
      )
      .execute()
    const nameOf = await teamNames(fixture.db, team, [people.babe.userId])
    expect(nameOf(people.jordanPujols.userId)).equals('Jordan Pu')
    expect(nameOf(people.babe.userId)).equals('Babe R')
    expect((await teamNames(fixture.db, team))(people.babe.userId)).equals(
      undefined
    )
  })

  it('scopes a game by everyone its plays, at-bat and pregame name, and digests their accounts', async () => {
    const game = makeId('game')
    const pregameOnly = makeId('game')
    for (const id of [game, pregameOnly])
      await fixture.db
        .insertInto('games')
        .values({
          id,
          start_at: new Date('2026-01-01T00:00:00Z'),
          home_team_id: 'tem_home',
          away_team_id: 'tem_away',
          season_id: 'sea_demo'
        })
        .execute()
    await fixture.db
      .insertInto('events')
      .values({
        id: makeId('event'),
        gameId: game,
        gumbo: JSON.stringify({
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: {
            batter: { id: people.jordanPujols.userId },
            pitcher: { id: people.babe.userId }
          }
        })
      })
      .execute()
    // An at-bat in progress naming a credited man; a pregame naming another.
    await fixture.db
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({
          about: { atBatIndex: 1 },
          credits: [{ creditUserId: people.jordanPerez.userId, credit: {} }]
        })
      })
      .where('id', '=', game)
      .execute()
    await fixture.db
      .updateTable('games')
      .set({
        pregame: JSON.stringify({
          version: 2,
          setupBefore: {
            players: {},
            sides: {},
            tagOrder: []
          },
          actions: []
        })
      })
      .where('id', '=', pregameOnly)
      .execute()
    const books = await gameNames(fixture.db, [game, pregameOnly, game])
    const book = books.get(game)!
    expect(book.nameOf(people.jordanPujols.userId)).equals('Jordan Pu')
    expect(book.nameOf(people.jordanPerez.userId)).equals('Jordan Pe')
    expect(book.nameOf(people.babe.userId)).equals('Babe R')
    expect(books.get(pregameOnly)!.nameOf(people.babe.userId)).equals(undefined)
    expect((await gameNames(fixture.db, [])).size).equals(0)
    const digest = await gameNamesDigest(fixture.db, game)
    expect(digest).equals(book.digest)
    expect(await gameNamesDigest(fixture.db, 'gam_missing')).equals('')
    await fixture.db
      .updateTable('users')
      .set({ display_name: 'Jordan Perez Jr' })
      .where('id', '=', userIdOfGumbo(people.jordanPerez.userId))
      .execute()
    expect(await gameNamesDigest(fixture.db, game)).not.equals(digest)
  })

  it("keeps a game's scope for its digest until a write moves it, reading no play meanwhile", async () => {
    const game = makeId('game')
    await fixture.db
      .insertInto('games')
      .values({
        id: game,
        start_at: new Date('2026-01-01T00:00:00Z'),
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        season_id: 'sea_demo'
      })
      .execute()
    const event = makeId('event')
    await fixture.db
      .insertInto('events')
      .values({
        id: event,
        gameId: game,
        gumbo: JSON.stringify({
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: { batter: { id: people.babe.userId } }
        })
      })
      .execute()
    // Every query the digest makes, as the tree Kysely builds of it.
    let queries: string[] = []
    const watched = fixture.db.withPlugin({
      transformQuery: args => {
        queries.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const readsPlays = (): boolean =>
      queries.some(query => query.includes('"name":"gumbo"'))
    const digestOf = async (): Promise<string> => {
      queries = []
      return await gameNamesDigest(watched, game)
    }
    const first = await digestOf()
    expect(readsPlays()).equals(true)
    expect(first).equals(
      (await gameNames(fixture.db, [game])).get(game)!.digest
    )
    // Asked again with nothing written: the accounts are read, no play.
    expect(await digestOf()).equals(first)
    expect(readsPlays()).equals(false)
    // A rename moves it without reading a play.
    await fixture.db
      .updateTable('users')
      .set({ display_name: 'George Ruth' })
      .where('id', '=', userIdOfGumbo(people.babe.userId))
      .execute()
    const renamed = await digestOf()
    expect(renamed).not.equals(first)
    expect(readsPlays()).equals(false)
    // A play, an event_players row or the at-bat written: read again.
    await fixture.db
      .updateTable('events')
      .set({
        gumbo: JSON.stringify({
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: {
            batter: { id: people.babe.userId },
            pitcher: { id: people.imported.userId }
          }
        })
      })
      .where('id', '=', event)
      .execute()
    const pitched = await digestOf()
    expect(readsPlays()).equals(true)
    expect(pitched).not.equals(renamed)
    await fixture.db
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: event,
        gumbo_id: people.jordanPerez.userId,
        team_id: null,
        role: 'fielder',
        position: null
      })
      .execute()
    const fielded = await digestOf()
    expect(readsPlays()).equals(true)
    expect(fielded).not.equals(pitched)
    await fixture.db
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({
          about: { atBatIndex: 1 },
          matchup: { batter: { id: people.jordanPujols.userId } }
        })
      })
      .where('id', '=', game)
      .execute()
    const batting = await digestOf()
    expect(readsPlays()).equals(true)
    expect(batting).not.equals(fielded)
    expect(batting).equals(
      (await gameNames(fixture.db, [game])).get(game)!.digest
    )
    expect(await digestOf()).equals(batting)
    expect(readsPlays()).equals(false)
  })

  it("names a page's games from their kept scopes, reading only the documents of a game written since", async () => {
    const games = [makeId('game'), makeId('game')]
    const events = new Map<string, string>()
    for (const [index, game] of games.entries()) {
      await fixture.db
        .insertInto('games')
        .values({
          id: game,
          start_at: new Date('2026-01-01T00:00:00Z'),
          home_team_id: 'tem_home',
          away_team_id: 'tem_away',
          season_id: 'sea_demo'
        })
        .execute()
      events.set(game, makeId('event'))
      await fixture.db
        .insertInto('events')
        .values({
          id: events.get(game)!,
          gameId: game,
          gumbo: JSON.stringify({
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single' },
            matchup: {
              batter: {
                id: [people.jordanPujols, people.jordanPerez][index].userId
              }
            }
          })
        })
        .execute()
    }
    let queries: string[] = []
    const watched = fixture.db.withPlugin({
      transformQuery: args => {
        queries.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const plays = (): number =>
      queries.filter(query => query.includes('"name":"gumbo"')).length
    const page = async (): Promise<Map<string, string | undefined>> => {
      queries = []
      const books = await gameNames(watched, games)
      return new Map(
        games.map(game => [
          game,
          books.get(game)!.nameOf(people.jordanPerez.userId) ??
            books.get(game)!.nameOf(people.jordanPujols.userId)
        ])
      )
    }
    const first = await page()
    expect([...first.values()]).deep.equals(['Jordan P', 'Jordan P'])
    // Both games' documents in one read.
    expect(plays()).equals(1)
    // Again: the stamps, the names and the formats, no document.
    expect(await page()).deep.equals(first)
    expect(queries).has.length(3)
    expect(plays()).equals(0)
    // One game tagged since: only its scope is read again, and a player its
    // tag names joins it.
    await fixture.db
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: events.get(games[0])!,
        gumbo_id: people.jordanPerez.userId,
        team_id: null,
        role: 'fielder',
        position: null
      })
      .execute()
    queries = []
    const books = await gameNames(watched, games)
    expect(plays()).equals(1)
    expect(
      queries.some(
        query => query.includes('"name":"gumbo"') && query.includes(games[1])
      )
    ).equals(false)
    expect(books.get(games[0])!.nameOf(people.jordanPujols.userId)).equals(
      'Jordan Pu'
    )
    expect(books.get(games[1])!.nameOf(people.jordanPerez.userId)).equals(
      'Jordan P'
    )
  })
})
