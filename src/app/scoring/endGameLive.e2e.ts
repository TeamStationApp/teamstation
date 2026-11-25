// Run against the branch's API and web build with their isolated test database.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  browserSession,
  maestro,
  type MaestroHandle
} from '../../../e2e/rigs/refinementsMaestro'
import { TeamStationClient } from '../../common/api'
import type { StoredGame } from '../../common/scoring/session'
import { makeDatabase } from '../../server/db/database'
import { createLineupGame, joinTeam } from '../../server/dev/lineupFixture'
import { loginUser, userMinter } from '../../server/dev/scoringGame'
import { signInTestAccount } from '../../test/passwordFixtures'

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `Set ${key} for the test stack`)
  return value
}

/** Wait for the save to reach the API, independently of the browser's cache. */
async function waitForBook(
  api: TeamStationClient,
  game: string,
  matches: (book: StoredGame) => boolean,
  description: string
): Promise<StoredGame> {
  const end = Date.now() + 30000
  do {
    const book = await api.gameEvents(game)
    if (matches(book)) return book
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < end)
  throw new Error(`The saved game did not reach ${description}`)
}

async function tap(m: MaestroHandle, label: string): Promise<void> {
  await m.tapOn({
    css: `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`,
    timeout: 15000
  })
}

async function main(): Promise<void> {
  const web = required('TS_SCORING_TEST_URL')
  const apiUrl = required('TS_API_TEST_URL')
  const db = makeDatabase(required('TS_END_GAME_DATABASE_URL'))
  const name = required('MAESTRO_D')
  const email = `scorekeeper-${randomUUID()}@example.test`
  const password = randomUUID()
  const game = await db
    .transaction()
    .execute(async trx => {
      const mint = await userMinter(trx)
      const fixture = await createLineupGame(trx, mint)
      const scorer = await loginUser(trx, mint, email, password, 'Scorekeeper')
      await joinTeam(trx, scorer, fixture.teams.home, 'scorekeeper')
      return fixture.gameId
    })
    .finally(async () => {
      await db.destroy()
    })
  const token = await signInTestAccount(apiUrl, { email, password })
  const api = new TeamStationClient({ baseUrl: apiUrl, token })
  const daemon = await maestro(name)
  const scratch = await mkdtemp(join(tmpdir(), 'end-game-browser-'))
  try {
    const { browser, m } = await browserSession(daemon, name, 430, 932, scratch)
    try {
      await browser.setCookie({
        name: 'ts_session',
        value: encodeURIComponent(token),
        domain: new URL(web).hostname,
        path: '/'
      })
      await m.openLink({ link: `${web}/games/${game}/score` })
      await tap(m, 'Ball')
      const live = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay?.count != null &&
          (book.currentPlay.count as { balls?: number }).balls === 1,
        'one ball'
      )
      await tap(m, 'Open scoring menu')
      await tap(m, 'End Game')
      await m.assertVisible({
        text: 'The open at-bat is saved with its pitches',
        timeout: 15000
      })
      await tap(m, 'Confirm End Game')
      const final = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay == null &&
          book.plays.some(play => play.result.eventType === 'final_score'),
        'the final score'
      )
      assert.deepEqual(
        final.plays.map(play => play.result.eventType),
        ['ts_at_bat_ended', 'final_score']
      )
      const events = final.plays[0].playEvents
      assert(Array.isArray(events))
      assert.deepEqual(
        events
          .filter(event => event.isPitch === true)
          .map(event => event.details.code),
        ['B']
      )
      await tap(m, 'Undo End game')
      const restored = await waitForBook(
        api,
        game,
        book =>
          book.currentPlay != null &&
          !book.plays.some(play => play.result.eventType === 'final_score'),
        'the restored live appearance'
      )
      assert(
        restored.plays.every(
          play => play.about.atBatIndex === live.currentPlay?.about.atBatIndex
        )
      )
      assert.equal(restored.currentPlay?.about.isComplete, false)
      assert.equal(
        restored.currentPlay?.about.atBatIndex,
        live.currentPlay?.about.atBatIndex
      )
      assert.equal(
        restored.currentPlay?.about.inning,
        live.currentPlay?.about.inning
      )
      assert.equal(
        restored.currentPlay?.about.halfInning,
        live.currentPlay?.about.halfInning
      )
      assert.deepEqual(restored.currentPlay?.count, live.currentPlay?.count)
      assert.deepEqual(
        restored.currentPlay?.playEvents,
        live.currentPlay?.playEvents
      )
      console.log(
        'PASS End Game saved the pitch and final score. Undo restored the open at-bat.'
      )
    } finally {
      await browser.disconnect()
      await m.detach()
    }
  } finally {
    await daemon.shutdown()
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
