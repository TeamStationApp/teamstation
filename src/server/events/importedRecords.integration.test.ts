import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { storedRecordOf } from '../../common/scoring/gumbo'
import * as converterModule from '../../common/scoring/importedRecord'
import { swapEffect } from '../../common/scoring/playsLost'
import * as storedNamesModule from '../../common/scoring/storedNames'
import { storedForm } from '../../common/scoring/storedNames'
import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase
} from '../../test/scoreboardKit'
import { closeInto } from '../admin/people'
import type { Database } from '../db/database'
import { scoredInTeamStation } from '../games/opponentFixed'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { hasRecordedPlays } from '../replay/replayable'
import { eventRoutes } from '../routes/events'
import { convertImportedGames } from './convertImportedGames'
import { postGamePlays } from './postPlays'

/**
 * A game an outside scorer posts gets a TeamStation record on every play, as
 * the scoring screen would have written it, so it replays and edits as a
 * game scored here. The invented game is the importer's own demo game, as
 * an outside scorer posts it; its people are made accounts of this database.
 */

type Json = Record<string, unknown>

const FIXTURE = 'src/common/scoring/fixtures/imported/inventedGame.json'

/** The invented game's plays, naming the people given, by their order. */
function inventedPlays(people: readonly Person[]): Json[] {
  const raw = readFileSync(FIXTURE, 'utf8').replace(
    /"id": (10\d\d)\b/g,
    (_, id: string) => `"id": ${people[Number(id) - 1000].gumboId}`
  )
  return JSON.parse(raw) as Json[]
}

function withoutEvents(plays: readonly Json[]): Json[] {
  return plays.map(play => ({ ...play, playEvents: [] }))
}

describe('records for an imported game', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let admin: Person
  let home = ''
  let away = ''
  const people: Person[] = []

  before(async function () {
    ;({ db, drop } = await scratchDatabase('imported_records'))
    home = await addTeam(db, 'Hosts')
    away = await addTeam(db, 'Visitors')
    admin = await addPerson(db, 'admin', { isAdmin: true })
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', admin.userId)
      .execute()
    for (let i = 0; i < 11; i++) people.push(await addPerson(db, `p${i}`))
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db, {}))
    app.use(errorHandler)
    server = app.listen(0)
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    await new Promise<void>(resolve => {
      if (server == null) resolve()
      else
        server.close(() => {
          resolve()
        })
    })
    await drop()
  })

  async function game(): Promise<string> {
    return await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date('2026-05-02T18:00:00.000Z')
    })
  }

  async function send(
    method: 'POST' | 'PATCH',
    gameId: string,
    body: unknown
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${base}/games/${gameId}/events`, {
      method,
      headers: {
        authorization: `Bearer ${admin.token}`,
        'content-type': 'application/json',
        // A live post comes from an app that writes this protocol.
        'x-teamstation-protocol': '5'
      },
      body: JSON.stringify(body)
    })
    return { status: res.status, body: (await res.json()) as Json }
  }

  async function storedPlays(gameId: string): Promise<Json[]> {
    return (
      await db
        .selectFrom('events')
        .select('gumbo')
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
    ).map(row => row.gumbo as Json)
  }

  it('gives every play of a posted game its record, and says so', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    const posted = await send('POST', gameId, {
      plays,
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    expect(posted.body.imported).deep.equals({
      plays: plays.length,
      pitches: 24,
      records: plays.length,
      corrections: 0
    })
    const stored = await storedPlays(gameId)
    expect(stored.every(play => storedRecordOf(play) != null)).equals(true)
    expect(await hasRecordedPlays(db, gameId, null)).equals(true)
    // Stored as TeamStation stores its own: nobody named, team by team.
    const record = stored[0].teamStation as Json
    expect(JSON.stringify(record.setupBefore)).not.match(/fullName":"[^"]/)
    for (const play of stored)
      expect(storedForm(play).document).deep.equals(play)
    // As a game scored here: its opponent is fixed, and a swap resets it.
    expect((await scoredInTeamStation(db, [gameId])).has(gameId)).equals(true)
    expect(
      swapEffect(
        { plays: stored, currentPlay: null },
        { status: 'scheduled', withdrawn: false }
      )
    ).equals('reset')
    // An app from before override slots reads it, as it read the import.
    const read = await fetch(`${base}/games/${gameId}/events`, {
      headers: { authorization: `Bearer ${admin.token}` }
    })
    expect(read.status).equals(200)
  })

  it('ends the game in its last record when the post finishes it', async function () {
    const gameId = await game()
    const posted = await send('POST', gameId, {
      plays: inventedPlays(people),
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    const row = await db
      .selectFrom('games')
      .select('status')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('final')
    const last = (await storedPlays(gameId)).at(-1)
    expect(storedRecordOf(last)?.actions.at(-1)).deep.equals({
      type: 'gameFlow',
      kind: 'endGame'
    })
    // Built again, the records come out as they are: nothing is written.
    const again = await convertImportedGames(db, {
      gameIds: [gameId],
      rebuild: true
    })
    expect(again.plays).equals(0)
  })

  it('builds the records of a play summary again when its pitches come', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: withoutEvents(plays),
        source: { system: 'outsideScorer' }
      })
    )
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', gameId)
      .execute()
    const before = await storedPlays(gameId)
    expect(before.every(play => storedRecordOf(play) != null)).equals(true)
    const actionsIn = (stored: Json[], types: string[]): number =>
      stored
        .flatMap(play => storedRecordOf(play)?.actions ?? [])
        .filter(action => types.includes(action.type)).length
    // A summary's only pitches are each walk's deciding ball.
    const walks = plays.filter(
      play => (play.result as Json).eventType === 'walk'
    ).length
    expect(actionsIn(before, ['pitch'])).equals(walks)
    const patched = await send('PATCH', gameId, {
      plays: plays.map(play => ({
        atBatIndex: (play.about as Json).atBatIndex,
        // Its pitches, as the importer sends them with their words: what a
        // play summary lacks, and what the records count.
        playEvents: (play.playEvents as Json[])
          .filter(event => event.isPitch === true)
          .map(event => {
            const details = event.details as Json
            return {
              ...event,
              description: String(details.code),
              details: {
                isInPlay: false,
                isStrike: false,
                isBall: false,
                isOut: false,
                hasReview: false,
                ...details,
                call: { code: details.code, description: String(details.code) },
                description: String(details.code)
              }
            }
          })
      }))
    })
    expect(patched.status, JSON.stringify(patched.body)).equals(200)
    expect(patched.body.imported).includes({
      plays: plays.length,
      records: plays.length
    })
    // A pitch or ball in play, and so a replay step, for every pitch posted.
    expect(
      actionsIn(await storedPlays(gameId), ['pitch', 'ballInPlay'])
    ).equals(24)
  })

  it('writes no records for a game whose turn at bat names nobody', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    const matchup = plays[1].matchup as Json
    plays[1] = { ...plays[1], matchup: { ...matchup, batter: { id: null } } }
    const posted = await send('POST', gameId, {
      plays,
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    expect(posted.body.imported).includes({
      records: 0,
      unconvertible: 'unnamedPlayers'
    })
    const stored = await storedPlays(gameId)
    expect(stored.some(play => storedRecordOf(play) != null)).equals(false)
  })

  it('strips every record when a live post adds a play that names nobody', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    const first = await send('POST', gameId, {
      plays: plays.slice(0, 3),
      mode: 'live',
      source: { system: 'outsideScorer' }
    })
    expect(first.body.imported).includes({ records: 3 })
    const later = plays[3]
    const posted = await send('POST', gameId, {
      plays: [
        {
          ...later,
          matchup: { ...(later.matchup as Json), batter: { id: null } }
        }
      ],
      mode: 'live',
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    expect(posted.body.imported).includes({
      records: 0,
      unconvertible: 'unnamedPlayers'
    })
    const stored = await storedPlays(gameId)
    expect(stored).length(4)
    expect(stored.some(play => storedRecordOf(play) != null)).equals(false)
  })

  it('builds every record again when a live post fills in a play it missed', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    // The importer missed the second play, and sends it after the third.
    const first = await send('POST', gameId, {
      plays: [plays[0], plays[2]],
      mode: 'live',
      source: { system: 'outsideScorer' }
    })
    expect(first.status).equals(200)
    const posted = await send('POST', gameId, {
      plays: [plays[1]],
      mode: 'live',
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    const stored = await storedPlays(gameId)
    // As the same three plays posted at once.
    const whole = await game()
    await send('POST', whole, {
      plays: plays.slice(0, 3),
      mode: 'live',
      source: { system: 'outsideScorer' }
    })
    const records = (rows: Json[]): unknown[] =>
      rows.map(row => storedRecordOf(row)?.actions)
    expect(records(stored)).deep.equals(records(await storedPlays(whole)))
  })

  it('stores the plays with no records when the converter fails on them', async function () {
    const gameId = await game()
    // The converter, as a play shape it cannot read would make it throw.
    const module = converterModule as { importedRecords: unknown }
    const real = module.importedRecords
    module.importedRecords = () => {
      throw new TypeError('a play shape the converter cannot read')
    }
    try {
      const plays = inventedPlays(people)
      const posted = await send('POST', gameId, {
        plays,
        source: { system: 'outsideScorer' }
      })
      expect(posted.status).equals(200)
      expect(posted.body.imported).includes({
        plays: plays.length,
        records: 0,
        unconvertible: 'unreadable'
      })
      expect(await storedPlays(gameId)).length(plays.length)
      expect(await hasRecordedPlays(db, gameId, null)).equals(false)
    } finally {
      module.importedRecords = real
    }
    // Or fails storing the records it built.
    const names = storedNamesModule as { storedForm: unknown }
    const realForm = names.storedForm
    names.storedForm = () => {
      throw new TypeError('a record the stored form cannot read')
    }
    try {
      const other = await game()
      const posted = await send('POST', other, {
        plays: inventedPlays(people),
        source: { system: 'outsideScorer' }
      })
      expect(posted.status).equals(200)
      expect(posted.body.imported).includes({
        records: 0,
        unconvertible: 'unreadable'
      })
    } finally {
      names.storedForm = realForm
    }
  })

  it('writes no records for a final score alone', async function () {
    const gameId = await game()
    const posted = await send('POST', gameId, {
      plays: [
        {
          about: { atBatIndex: 0, inning: 7, halfInning: 'bottom' },
          result: { eventType: 'final_score', awayScore: 2, homeScore: 5 },
          count: { outs: 3 }
        }
      ],
      source: { system: 'outsideScorer' }
    })
    expect(posted.status).equals(200)
    expect(posted.body.imported).includes({
      records: 0,
      unconvertible: 'noPlayByPlay'
    })
    expect(await hasRecordedPlays(db, gameId, null)).equals(false)
  })

  it('takes a TeamStation correction to a final imported game, which then is TeamStation’s', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    await send('POST', gameId, { plays, source: { system: 'outsideScorer' } })
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', gameId)
      .execute()
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        mode: 'live',
        plays: [],
        currentPlay: null,
        source: { system: 'teamstation' }
      })
    )
    const owner = await db
      .selectFrom('games')
      .select('scoringOwner')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(owner.scoringOwner).equals('teamstation')
    // From here an outside scorer is refused, as on a game scored here.
    await db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', gameId)
      .execute()
    const refused = await send('POST', gameId, {
      plays,
      source: { system: 'outsideScorer' }
    })
    expect(refused.status).equals(409)
    expect(refused.body.message).equals('This game is scored in TeamStation')
  })

  it('replaces a final imported game’s plays for a node administrator, and no one else', async function () {
    const gameId = await game()
    const plays = inventedPlays(people)
    await send('POST', gameId, { plays, source: { system: 'outsideScorer' } })
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', gameId)
      .execute()
    await db
      .updateTable('events')
      .set({ hidden: true })
      .where('gameId', '=', gameId)
      .where('atBatIndex', '=', 0)
      .execute()
    // The same plays, one classified anew, as a rebuild would send them.
    const rebuilt = structuredClone(plays)
    rebuilt[3] = {
      ...rebuilt[3],
      result: { ...(rebuilt[3].result as Json), eventType: 'field_out' }
    }
    const replaced = await send('POST', gameId, {
      plays: rebuilt,
      source: { system: 'outsideScorer' },
      replaceFinal: true
    })
    expect(replaced.status, JSON.stringify(replaced.body)).equals(200)
    const after = await db
      .selectFrom('games')
      .select(['status', 'scoringOwner'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(after).deep.equals({ status: 'final', scoringOwner: null })
    const stored = await storedPlays(gameId)
    expect(stored.every(play => storedRecordOf(play) != null)).equals(true)
    const hidden = await db
      .selectFrom('events')
      .select('hidden')
      .where('gameId', '=', gameId)
      .where('atBatIndex', '=', 0)
      .executeTakeFirstOrThrow()
    expect(hidden.hidden).equals(true)
    // Fewer plays than the game holds is no repair.
    const short = await send('POST', gameId, {
      plays: rebuilt.slice(1),
      source: { system: 'outsideScorer' },
      replaceFinal: true
    })
    expect(short.status).equals(400)
    // Anybody but a node administrator is refused.
    const res = await fetch(`${base}/games/${gameId}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${people[0].token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        plays: rebuilt,
        source: { system: 'outsideScorer' },
        replaceFinal: true
      })
    })
    expect(res.status).equals(403)
    // A game TeamStation owns is its scorers': no repair replaces it.
    await db
      .updateTable('games')
      .set({ scoringOwner: 'teamstation' })
      .where('id', '=', gameId)
      .execute()
    const owned = await send('POST', gameId, {
      plays: rebuilt,
      source: { system: 'outsideScorer' },
      replaceFinal: true
    })
    expect(owned.status).equals(409)
  })

  it('leaves readable from its documents a game its records would not read', async function () {
    // Two people, one batting for each side, are found to be one account.
    const merged = [...people]
    merged[0] = await addPerson(db, 'one')
    merged[10] = await addPerson(db, 'same')
    await closeInto(db, merged[10].userId, merged[0].userId)
    // Stored before the accounts were merged, as an older import left it.
    const gameId = await game()
    for (const play of inventedPlays(merged))
      await db
        .insertInto('events')
        .values({
          id: makeId('event'),
          gameId,
          gumbo: play,
          source: 'external'
        })
        .execute()
    const converted = await convertImportedGames(db, { gameIds: [gameId] })
    expect(converted.unreadable).deep.equals([gameId])
    const res = await fetch(`${base}/games/${gameId}/events`, {
      headers: { authorization: `Bearer ${admin.token}` }
    })
    expect(res.status).equals(200)
    expect(await hasRecordedPlays(db, gameId, null)).equals(false)
  })

  it('answers a TeamStation post as before, with no imported counts', async function () {
    const gameId = await game()
    const answer = await postGamePlays(
      db,
      gameId,
      asPostEventsBody({ plays: [], source: { system: 'teamstation' } })
    )
    expect(answer).not.have.property('imported')
  })
})
