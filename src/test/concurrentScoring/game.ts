import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { ConcurrentScoringRig } from './concurrentScoring'
import type { E2eContext } from './context'

// The completed plays this journey requires. Missing required fields fail
// the oracle instead of silently treating an incomplete record as zero.
interface CompletedPlay {
  about: { atBatIndex: number; inning: number; halfInning: string }
  count: { outs: number }
  result: { eventType: string }
  matchup: { batter: { id: number } }
  teamStation: { setupBefore: { sides: { home: { defense: { SS: number } } } } }
  runners: Array<{
    credits: Array<{ credit: string; player: { id: number } }>
    movement: { isOut: boolean; end: string | null }
    details: { runner: { id: number } }
  }>
}

export async function fourInnings(
  rig: ConcurrentScoringRig,
  ctx: E2eContext
): Promise<void> {
  await rig.open()
  let plays = 0
  const closed = async (author: number): Promise<void> => {
    await rig.finish(author)
    await rig.boundary(author, ++plays)
  }
  const strikeouts = async (author: number, count: number): Promise<void> => {
    for (let out = 0; out < count; out++) {
      await rig.strikeout(author)
      await rig.boundary(author, ++plays)
    }
  }
  for (let inning = 1; inning <= 4; inning++) {
    const top = 1
    const bottom = 0
    if (inning === 1) {
      await rig.hit(top, 'Single')
      await closed(top)
      await rig.hit(top, "Fielder's Choice", 5)
      await rig.defender(top, 4, 2)
      await rig.tap(top, '^Finish defensive play$')
      await rig.tap(top, '^Out$')
      await closed(top)
      await strikeouts(top, 2)
    } else if (inning === 2) {
      await rig.hit(top, 'Error', 5)
      await rig.redoTrajectory(top, 5)
      await rig.tap(top, '^Finish defensive play$')
      await rig.tap(top, '^Error by .*')
      await closed(top)
      await strikeouts(top, 3)
    } else if (inning === 3) {
      await rig.pitch(top, 'Called Strike')
      await rig.pitch(top, 'Called Strike')
      await rig.more(top, 'Dropped Third Strike')
      await rig.tap(top, '^Out$')
      await rig.defender(top, 3, 1)
      await rig.tap(top, '^Finish defensive play$')
      await closed(top)
      await strikeouts(top, 2)
    } else if (inning === 4) {
      await rig.more(top, 'Intentional Walk')
      await closed(top)
      await strikeouts(top, 3)
      await rig.undo(bottom)
      await rig.agree(bottom, '2 strikes 2 outs')
      await rig.pitch(bottom, 'Called Strike')
      await rig.finish(bottom)
      await rig.boundary(bottom, plays)
    }

    if (inning === 1) await rig.coachChange()
    if (inning === 1) {
      await rig.pitch(bottom, 'Called Strike')
      await rig.pitch(bottom, 'Called Strike')
      await rig.more(bottom, 'Dropped Third Strike')
      await rig.tap(bottom, '^Safe$')
      await closed(bottom)
    } else if (inning === 2) {
      for (let ball = 0; ball < 4; ball++) await rig.pitch(bottom, 'Ball')
      await closed(bottom)
      await rig.hit(bottom, 'Home Run')
      await closed(bottom)
      await rig.undoAtBat(bottom)
      await rig.boundary(bottom, --plays)
      await rig.hit(bottom, 'Home Run')
      await closed(bottom)
    } else if (inning === 3) {
      await rig.pitch(bottom, 'Foul Ball')
      await rig.undo(bottom)
      await rig.more(bottom, 'Hit by Pitch')
      await closed(bottom)
    } else if (inning === 4) {
      await rig.tap(bottom, '^Bunt in Play$')
      await rig.tap(bottom, '^Batter Out$')
      await rig.tap(bottom, '^Ground Out$')
      await rig.defender(bottom, 6)
      await rig.trajectory(bottom)
      await rig.defender(bottom, 3, 1)
      await rig.tap(bottom, '^Finish defensive play$')
      await closed(bottom)
    }
    await strikeouts(bottom, inning === 4 ? 2 : 3)
    await rig.capture(`inning-${inning}`)
    if (inning === 2) await rig.coachChange()
  }
  await rig.endGame(0)
  await ctx.checkpoint(
    'four-inning-final',
    {
      readBack: async () => {
        const events = await rig.api.gameEvents(rig.fixture.ids.game)
        const completed = events.plays.filter(
          play => play.about.atBatIndex !== 9999
        ) as unknown as CompletedPlay[]
        assert.equal(plays, 31)
        assert.equal(completed.length, 31)
        assert.equal(
          new Set(completed.map(play => play.about.atBatIndex)).size,
          31,
          'No duplicated plays'
        )
        for (let inning = 1; inning <= 4; inning++) {
          for (const half of ['top', 'bottom']) {
            const halfPlays = completed.filter(
              play =>
                play.about.inning === inning && play.about.halfInning === half
            )
            assert.equal(
              halfPlays.at(-1)?.count.outs,
              3,
              `${half} ${inning} finishes with three outs`
            )
            assert.equal(
              halfPlays
                .flatMap(play => play.runners)
                .filter(runner => runner.movement.isOut).length,
              3,
              `${half} ${inning} has exactly three runner outs`
            )
          }
        }
        assert.equal(completed[0].result.eventType, 'single')
        assert.equal(completed[1].result.eventType, 'force_out')
        assert.equal(
          completed[1].runners.find(runner => runner.movement.isOut)?.details
            .runner.id,
          completed[0].matchup.batter.id,
          'FC retires the single runner'
        )
        assert.equal(completed[8].result.eventType, 'field_error')
        const errors = completed.flatMap(play =>
          play.runners.flatMap(runner =>
            runner.credits
              .filter(
                credit =>
                  credit.credit === 'f_fielding_error' ||
                  credit.credit === 'f_throwing_error'
              )
              .map(credit => ({
                half: play.about.halfInning,
                player: credit.player.id
              }))
          )
        )
        assert.deepEqual(
          errors,
          [
            {
              half: 'top',
              player: completed[8].teamStation.setupBefore.sides.home.defense.SS
            }
          ],
          'Exactly one error, charged to the home shortstop'
        )
        assert.equal(completed[13].result.eventType, 'home_run')
        assert.deepEqual(
          completed[13].runners
            .filter(runner => runner.movement.end === 'score')
            .map(runner => runner.details.runner.id)
            .sort((a, b) => a - b),
          [
            completed[12].matchup.batter.id,
            completed[13].matchup.batter.id
          ].sort((a, b) => a - b),
          'The walk and homer batters score once each'
        )
        const game = await rig.api.game(rig.fixture.ids.game)
        assert.equal(game.status, 'final')
        assert.equal(game.awayScore, 0)
        assert.equal(game.homeScore, 2)
        const deadline = Date.now() + 60000
        let box = await rig.api.boxScore(rig.fixture.ids.game)
        while (box.stats?.status !== 'built' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 500))
          box = await rig.api.boxScore(rig.fixture.ids.game)
        }
        assert.equal(
          box.stats?.status,
          'built',
          'Final statistics finish building'
        )
        for (const side of ['away', 'home'] as const) {
          const batters = box.batting.filter(
            row => row.teamId === rig.fixture.ids[side]
          )
          assert.equal(
            batters.reduce((sum, row) => sum + row.h, 0),
            1
          )
          assert.equal(
            batters.reduce((sum, row) => sum + row.hr, 0),
            side === 'away' ? 0 : 1
          )
          assert.equal(
            batters.reduce((sum, row) => sum + row.r, 0),
            side === 'away' ? 0 : 2
          )
          const pitcher = box.pitching.filter(
            row => row.teamId === rig.fixture.ids[side]
          )
          assert.equal(pitcher.length, 1)
          assert.equal(pitcher[0].ip, '4.0')
          assert.equal(pitcher[0].outs, 12)
        }
        for (const row of box.batting) {
          const hits = completed.filter(
            play =>
              row.gumboIds.includes(play.matchup.batter.id) &&
              ['single', 'home_run'].includes(play.result.eventType)
          )
          assert.equal(row.h, hits.length, `${row.shortName} hit credits`)
          const runs = completed
            .flatMap(play => play.runners)
            .filter(
              runner =>
                row.gumboIds.includes(runner.details.runner.id) &&
                runner.movement.end === 'score'
            )
          assert.equal(row.r, runs.length, `${row.shortName} run credits`)
          assert.equal(
            row.hr,
            hits.filter(play => play.result.eventType === 'home_run').length,
            `${row.shortName} homer credits`
          )
        }
        await writeFile(
          ctx.artifact('final-oracle.json'),
          JSON.stringify({ game, events, box }, null, 2)
        )
      }
    },
    rig.clients[2].m
  )

  await rig.tap(2, '^Box$')
  await rig.expectText(2, 'Pitching', 15000)
  await rig.capture('four-innings-final')
}
