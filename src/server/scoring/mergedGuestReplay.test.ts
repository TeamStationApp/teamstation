import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { replayPlays } from '../../common/scoring/gumbo'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import { asLegacyGameSetup } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import { resolveScoringGame } from './openRow'

describe('saved lineup changes after account merges', function () {
  this.timeout(15000)
  let fixture: AccountHarness
  beforeEach(async () => {
    fixture = await accountHarness()
    await insertFixtureUsers(
      fixture.db,
      [...Array.from({ length: 16 }, (_, i) => i + 103), 201].map(id => ({
        id,
        display_name: 'Mike Trout',
        login_enabled: false
      }))
    )
  })
  afterEach(async () => {
    await fixture?.close()
  })

  for (const version of [1, 2])
    for (const kind of ['addPlayer', 'roster'] as const)
      it(`reopens version ${version} ${kind} and continues scoring without changing stored history`, async () => {
        const teams = {
          away: { id: 'tem_away', name: 'Owls' },
          home: { id: 'tem_home', name: 'Hawks' }
        }
        const roster = (
          start: number
        ): Array<{ gumboId: number; shortName: string }> =>
          Array.from({ length: 9 }, (_, i) => ({
            gumboId: start + i,
            shortName: 'Mike T'
          }))
        const setup = newSetup(teams, { away: roster(101), home: roster(110) })
        const old = asLegacyGameSetup({
          ...setup,
          players: Object.fromEntries(
            Object.values(setup.players).map(player => [
              player.id - 100,
              { ...player, id: player.id - 100, userId: player.id }
            ])
          ),
          sides: Object.fromEntries(
            Object.entries(setup.sides).map(([side, team]) => [
              side,
              {
                ...team,
                players: team.players.map(id => id - 100),
                battingOrder: team.battingOrder.map(id => id - 100),
                defense: Object.fromEntries(
                  Object.entries(team.defense).map(([position, id]) => [
                    position,
                    id == null ? null : id - 100
                  ])
                )
              }
            ])
          ),
          identities: {
            nextId: 19,
            sessionToSource: Object.fromEntries([
              ...Array.from({ length: 18 }, (_, i) => [i + 1, i + 101]),
              [19, 201]
            ]),
            sourceToSession: Object.fromEntries([
              ...Array.from({ length: 18 }, (_, i) => [
                `number:${i + 101}`,
                i + 1
              ]),
              ['number:201', 19]
            ])
          }
        })
        const stored: StoredGame = {
          plays: [],
          currentPlay: {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            },
            teamStation: {
              version,
              setupBefore: version === 1 ? old : setup,
              actions: [
                ...(kind === 'roster'
                  ? [
                      {
                        type: 'lineup',
                        kind: 'roster',
                        setup: version === 1 ? old : setup
                      }
                    ]
                  : [
                      {
                        type: 'lineup',
                        kind: 'addPlayer',
                        side: 'away',
                        ...(version === 1 ? {} : { player: 201 }),
                        name: 'Babe Ruth',
                        jersey: '20'
                      }
                    ]),
                { type: 'pitch', call: 'B' }
              ]
            }
          }
        }
        const context = { gamePk: 'gam_merge_guest', teams, setup }
        const before = structuredClone(stored)
        expect(replayPlays(stored, context).problems).deep.equals([])
        await closeInto(
          fixture.db,
          userIdOfGumbo(kind === 'roster' ? 102 : 201),
          userIdOfGumbo(101)
        )
        const projected = await resolveScoringGame(fixture.db, stored)
        const replayed = replayPlays(projected, context)
        expect(replayed.problems).deep.equals([])
        const opened = await ScoringSession.open(
          {
            load: async () => projected,
            save: async () => {
              throw new Error('Read-only test store')
            }
          },
          context.gamePk,
          context,
          { setTimer: () => null, clearTimer: () => undefined }
        )
        expect(opened.problem).equals(null)
        expect(
          opened.state.liveData.boxscore.teams.away.players.filter(
            id => id === 101
          )
        ).length(1)
        expect(opened.state.gameData.players[101].jersey).not.equals('20')
        if (kind === 'roster') {
          expect(
            opened.state.liveData.boxscore.teams.away.battingOrder
          ).deep.equals([101, 101, 103, 104, 105, 106, 107, 108, 109])
          expect(opened.state.liveData.boxscore.teams.away.defense.P).equals(
            101
          )
          expect(opened.state.liveData.boxscore.teams.away.defense.C).equals(
            101
          )
        }
        expect(opened.state.liveData.linescore.balls).equals(1)
        expect(opened.apply({ type: 'pitch', call: 'C' }).problems).deep.equals(
          []
        )
        expect(opened.state.liveData.linescore.strikes).equals(1)
        expect(stored).deep.equals(before)
      })
})
