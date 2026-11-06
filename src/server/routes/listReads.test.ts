import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client } from 'pg'

import { makeId } from '../../common/ids'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { recordStatements } from '../../test/pgStatements'
import { databaseUrlOf } from '../../test/screenScopeNotices'

/** A statement a GET sent, and its connection's state once it answered. */
interface Sampled {
  text: string
  state: string | null
}

/**
 * The list GETs a screen reads on a notice hold a pooled connection only for
 * each statement: between statements it sits `idle`, never `idle in
 * transaction`. Each statement's answer is held while another connection
 * reads `pg_stat_activity` for it, as a slow handler would leave it.
 */
describe('list reads without a transaction', function () {
  this.timeout(60000)
  let f: GroupFixture
  let sampler: Client
  let gameId = ''

  before(async () => {
    f = await groupFixture()
    gameId = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date()
      })
      .execute()
    sampler = new Client({ connectionString: await databaseUrlOf(f.h.db) })
    await sampler.connect()
  })

  after(async () => {
    await sampler?.end()
    await f?.h.close()
  })

  /** Every statement `path` sent, with its connection's state after it. */
  const sampled = async (path: string): Promise<Sampled[]> => {
    const own = (sampler as unknown as { processID: number }).processID
    const samples: Sampled[] = []
    // One sample at a time: the sampler is one connection.
    let turn = Promise.resolve()
    const sample = async (pid: number, text: string): Promise<void> => {
      const { rows } = await sampler.query<{ state: string | null }>(
        'select state from pg_stat_activity where pid = $1',
        [pid]
      )
      samples.push({ text, state: rows[0]?.state ?? null })
    }
    await recordStatements(
      async () => {
        const response = await f.h.request('GET', path, undefined, 101)
        expect(response.status, path).equals(200)
      },
      {
        hold: async ({ pid, text }) => {
          if (pid == null || pid === own) return
          turn = turn.then(async () => {
            await sample(pid, text)
          })
          await turn
        }
      }
    )
    return samples
  }

  it('leaves the connection idle, not idle in transaction, between the statements of a slowed list GET', async function () {
    for (const path of [
      '/events',
      '/events?when=upcoming',
      '/teams',
      '/seasons',
      '/me/home',
      '/me/roles',
      '/me/groups',
      '/me/follows',
      '/live',
      '/users?guardedBy=me',
      `/teams/${f.teamA}/roster`,
      `/teams/${f.teamA}/default-lineup`,
      `/games/${gameId}`,
      `/games/${gameId}/lineups`
    ]) {
      const samples = await sampled(path)
      expect(samples.length, path).greaterThan(0)
      expect(
        samples.filter(sample => sample.state !== 'idle'),
        path
      ).deep.equals([])
      expect(
        samples.some(sample => /^(begin|start transaction)/i.test(sample.text)),
        path
      ).equals(false)
    }
  })

  it('reads a game’s plays and its row in one read-only snapshot', async function () {
    const samples = await sampled(`/games/${gameId}/events`)
    const begun = samples.findIndex(sample =>
      /^start transaction isolation level repeatable read read only$/i.test(
        sample.text
      )
    )
    const committed = samples.findIndex(
      (sample, index) => index > begun && sample.text === 'commit'
    )
    expect(begun, JSON.stringify(samples)).greaterThan(-1)
    expect(committed).greaterThan(begun)
    const inside = samples.slice(begun + 1, committed)
    expect(inside.some(sample => sample.text.includes('from "events"'))).equals(
      true
    )
    expect(inside.some(sample => sample.text.includes('from "games"'))).equals(
      true
    )
    expect(
      inside.filter(sample => sample.state !== 'idle in transaction')
    ).deep.equals([])
  })
})
