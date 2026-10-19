import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { mintUserId } from '../../common/mintUserId'
import { recordOf } from '../../common/scoring/gumbo'
import { newSetup } from '../../common/scoring/lineup'
import {
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { statsDatabase } from '../../test/statsDatabase'
import { closeInto, survivorsOf } from '../admin/people'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer, storedLineupsDigest } from '../events/teamLineups'
import {
  computeBoardTimeline,
  timelineVersion
} from '../scoreboard/boardTimeline'
import { scoreboardFromGame } from '../scoreboard/gameSource'
import { resolveScoringGame } from './openRow'

// Full persisted rosters, including a guest whose account later closes into another.
describe('opening scoring through account merges', function () {
  this.timeout(60000)
  const fixture = statsDatabase('openrow')
  const users = Array.from({ length: 18 }, () => mintUserId(() => false))
  const teams = {
    away: { id: 'tem_away', name: 'Owls' },
    home: { id: 'tem_home', name: 'Hawks' }
  }
  const roster = (
    start: number
  ): Array<{ userId: number; shortName: string; jersey: string }> =>
    users.slice(start, start + 9).map((user, i) => ({
      userId: user.userId,
      shortName: `Player ${i + 1}`,
      jersey: String(i + 1)
    }))
  const setup = newSetup(teams, { away: roster(0), home: roster(9) })
  const context = { gamePk: 'gam_demo', teams, setup }
  const options = { setTimer: () => null, clearTimer: () => undefined }
  before(async () => {
    await fixture.db
      .updateTable('users')
      .set({ first_name: 'Miguel', last_name: 'Cabrera' })
      .where('id', '=', fixture.ids[0])
      .execute()
    await fixture.db
      .insertInto('users')
      .values(
        users.map(user => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: 'Mike Trout',
          login_enabled: false
        }))
      )
      .execute()
  })
  const raw = async (): Promise<StoredGame> => ({
    plays: (await readPlays(fixture.db, 'gam_demo')).map(
      row => row.gumbo as GumboPlay
    ),
    currentPlay: (
      await fixture.db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', 'gam_demo')
        .executeTakeFirstOrThrow()
    ).currentPlay as CurrentPlay | null
  })
  const store: EventStore = {
    load: async () => await resolveScoringGame(fixture.db, await raw()),
    save: async (_id, change) => {
      const posted = await postGamePlays(
        fixture.db,
        'gam_demo',
        asPostEventsBody({
          ...change,
          source: { system: 'teamstation' },
          mode: 'live'
        })
      )
      return {
        plays: posted.plays.map(row => row.gumbo as GumboPlay),
        currentPlay: posted.currentPlay as CurrentPlay | null
      }
    }
  }
  it('opens as the survivor, writes the next play with that identity and keeps completed history intact', async () => {
    const session = await ScoringSession.open(
      store,
      'gam_demo',
      context,
      options
    )
    for (let i = 0; i < 3; i++)
      expect(session.apply({ type: 'pitch', call: 'C' }).problems).deep.equals(
        []
      )
    expect(
      session.apply({ type: 'gameFlow', kind: 'closePlay' }).problems
    ).deep.equals([])
    expect(
      session.apply({
        type: 'gameFlow',
        kind: 'override',
        batter: users[0].userId
      }).problems
    ).deep.equals([])
    expect(session.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    const before = await raw()
    const historical = JSON.stringify(before.plays)
    const original = users[0].userId
    const survivor = fixture.ids[0]
    const oldTimelineVersion = await timelineVersion(fixture.db, 'gam_demo')
    await closeInto(fixture.db, original, survivor)
    expect(await timelineVersion(fixture.db, 'gam_demo')).not.equals(
      oldTimelineVersion
    )
    expect(
      (await scoreboardFromGame(fixture.db, 'gam_demo', () => undefined))!.state
        .batterName
    ).includes('Miguel')
    expect(
      (await computeBoardTimeline(fixture.db, 'gam_demo'))!.steps.at(-1)!.state
        .batterName
    ).includes('Miguel')
    await fixture.db
      .updateTable('games')
      .set({ lineups_digest: null })
      .where('id', '=', 'gam_demo')
      .execute()
    const gameRow = await fixture.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', 'gam_demo')
      .executeTakeFirstOrThrow()
    expect(await storedLineupsDigest(fixture.db, gameRow)).equals(
      (await lineupsAnswer(fixture.db, gameRow)).digest
    )
    const projected = await resolveScoringGame(fixture.db, before)
    expect(JSON.stringify(before.plays)).equals(historical)
    expect(await raw()).deep.equals(before)
    const opened = await ScoringSession.open(
      store,
      'gam_demo',
      context,
      options
    )
    expect(opened.state.liveData.boxscore.teams.away.battingOrder[0]).equals(
      survivor
    )
    expect(opened.state.liveData.boxscore.teams.away.defense.P).equals(survivor)
    expect(opened.state.liveData.plays.currentPlay!.matchup.batter.id).equals(
      survivor
    )
    expect(projected.plays[0].matchup?.batter?.id).equals(survivor)
    expect(projected.plays[0].credits).deep.equals(
      before.plays[0].credits?.map(credit => ({
        ...credit,
        creditUserId:
          credit.creditUserId === original ? survivor : credit.creditUserId
      }))
    )
    expect(opened.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await opened.flush()
    expect(opened.problem).equals(null)
    const after = await raw()
    expect(JSON.stringify(after.plays)).equals(historical)
    expect(
      recordOf(after.currentPlay)!.setupBefore.sides.away.battingOrder[0]
    ).equals(survivor)
    expect(
      (after.currentPlay!.matchup as { batter: { id: number } }).batter.id
    ).equals(survivor)
  })
  it('deduplicates merged options and sums pitch counts without dropping historical credits', async () => {
    const original = users[0].userId
    const survivor = fixture.ids[0]
    const saved = await raw()
    const record = recordOf(saved.plays[0])!
    const aliasSetup = structuredClone(record.setupBefore)
    aliasSetup.players[survivor] = {
      ...aliasSetup.players[original],
      id: survivor,
      userId: survivor
    }
    aliasSetup.sides.away.players.push(survivor)
    aliasSetup.tagOrder.push(survivor)
    aliasSetup.sides.away.pitchCounts[original] = 7
    aliasSetup.sides.away.pitchCounts[survivor] = 9
    const source = {
      plays: [
        {
          ...saved.plays[0],
          teamStation: {
            ...record,
            setupBefore: aliasSetup,
            extraMetadata: { kept: true },
            detail: {
              fieldingRoute: [
                { player: { id: original }, location: { x: 1, z: 2 } }
              ],
              runnerActions: [
                {
                  runner: { id: original },
                  origin: 1,
                  credits: [{ player: { id: original } }]
                }
              ]
            }
          },
          hitData: { fielder: { id: original } },
          credits: [
            { creditUserId: original, credit: {} },
            { creditUserId: survivor, credit: {} }
          ]
        }
      ],
      currentPlay: null
    }
    const expectedSource = JSON.stringify(source)
    const projected = await resolveScoringGame(fixture.db, source)
    const result = recordOf(projected.plays[0])!.setupBefore
    expect(result.sides.away.players.filter(id => id === survivor)).has.length(
      1
    )
    expect(result.tagOrder.filter(id => id === survivor)).has.length(1)
    expect(result.sides.away.pitchCounts[survivor]).equals(16)
    expect(
      projected.plays[0].credits.map(credit => credit.creditUserId)
    ).deep.equals([survivor, survivor])
    expect(projected.plays[0].hitData.fielder.id).equals(survivor)
    expect(projected.plays[0].teamStation.extraMetadata).deep.equals({
      kept: true
    })
    expect(recordOf(projected.plays[0])!.detail).deep.equals({
      fieldingRoute: [{ player: { id: survivor }, location: { x: 1, z: 2 } }],
      runnerActions: [
        {
          runner: { id: survivor },
          origin: 1,
          credits: [{ player: { id: survivor } }]
        }
      ]
    })
    expect(JSON.stringify(source)).equals(expectedSource)
    aliasSetup.players[survivor].teamId = teams.home.id
    let error: unknown
    try {
      await resolveScoringGame(fixture.db, structuredClone(source))
    } catch (caught) {
      error = caught
    }
    expect((error as Error).message).includes('opposing teams')
  })

  it('follows a second merge, leaves open identities alone and refuses missing or cyclic chains', async () => {
    const [middle, survivor] = fixture.ids
    await closeInto(fixture.db, middle, survivor)
    const projected = await resolveScoringGame(fixture.db, await raw())
    const opened = await ScoringSession.open(
      { ...store, load: async () => projected },
      'gam_demo',
      context,
      options
    )
    expect(opened.state.liveData.boxscore.teams.away.battingOrder[0]).equals(
      survivor
    )
    const open = await survivorsOf(fixture.db, [survivor, users[0].userId])
    expect([...open.values()]).deep.equals([survivor, survivor])
    for (const corrupt of ['missing', 'cycle']) {
      if (corrupt === 'cycle')
        await fixture.db
          .updateTable('users')
          .set({ merged_into: middle })
          .where('id', '=', survivor)
          .execute()
      let error: unknown
      try {
        await survivorsOf(fixture.db, corrupt === 'missing' ? [1] : [middle])
      } catch (caught) {
        error = caught
      }
      expect(error).instanceOf(Error)
    }
    await fixture.db
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', survivor)
      .execute()
  })
})
