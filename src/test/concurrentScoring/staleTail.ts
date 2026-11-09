import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import type { StoredGame } from '../../common/scoring/session'
import type { ConcurrentScoringRig } from './concurrentScoring'

/** A disconnected early scorer cannot erase accepted innings; current Undo can. */
export async function staleTail(rig: ConcurrentScoringRig): Promise<void> {
  await rig.open()
  const isolated = rig.clients[0].page
  assert(isolated != null, 'Stale-tail isolation requires Chromium')
  const read = async (): Promise<StoredGame> =>
    await rig.api.gameEvents(rig.fixture.ids.game)
  const completed = (game: StoredGame): number =>
    game.plays.filter(
      play =>
        play.about.atBatIndex !== 9999 &&
        play.about.atBatIndex !== game.currentPlay?.about.atBatIndex
    ).length
  const wait = async (
    check: () => Promise<boolean>,
    label: string
  ): Promise<void> => {
    const until = Date.now() + 15000
    while (!(await check())) {
      if (Date.now() >= until) throw new Error(`Timed out: ${label}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const acceptedAction = async (action: () => Promise<void>): Promise<void> => {
    const prior = JSON.stringify((await read()).scoringMutation)
    await action()
    await wait(
      async () => JSON.stringify((await read()).scoringMutation) !== prior,
      'scoring action accepted'
    )
  }
  const reconnect = async (
    expected: StoredGame,
    label: string
  ): Promise<void> => {
    await isolated.setOfflineMode(false)
    await wait(
      async () => (await rig.summary(0)) === rig.savedSummary(expected),
      'isolated scorer adopts canonical timeline'
    )
    await rig.converge(1, label)
    const after = await read()
    assert.deepEqual(
      after.plays,
      expected.plays,
      'Stale pitch cannot replace accepted completed plays'
    )
    assert.deepEqual(
      after.currentPlay,
      expected.currentPlay,
      'Stale pitch cannot replace accepted current play'
    )
    assert.deepEqual(
      after.scoringMutation,
      expected.scoringMutation,
      'Stale pitch cannot advance accepted version'
    )
    await rig.capture(label)
  }
  try {
    const initial = await rig.summary(0)
    await isolated.setOfflineMode(true)
    for (let out = 0; out < 12; out++) {
      for (let strike = 0; strike < 3; strike++)
        await acceptedAction(async () => {
          await rig.pitch(1, 'Called Strike', true)
        })
      await wait(async () => {
        if (completed(await read()) === out + 1) return true
        return await rig.clients[1].page!.evaluate(
          () => document.querySelector('[aria-label="Finish at-bat"]') != null
        )
      }, 'strikeout completion control or automatic close')
      if (completed(await read()) !== out + 1) await rig.finish(1)
      await wait(
        async () => completed(await read()) === out + 1,
        'completed strikeout'
      )
    }
    const accepted = await read()
    assert.equal(completed(accepted), 12)
    assert.equal(
      await rig.summary(0),
      initial,
      'Isolated scorer must still be two innings behind'
    )
    await rig.pitch(0, 'Ball', true)
    await reconnect(accepted, 'stale-two-innings-rejected')
    await rig.pitch(0, 'Ball')
    assert.equal(
      completed(await read()),
      12,
      'Recovered scorer continues without losing innings'
    )
    // Each Undo is explicitly authored from the preceding accepted result.
    for (let step = 0; step < 13; step++)
      await acceptedAction(async () => {
        await rig.undo(0)
      })
    await rig.pitch(0, 'Ball')
    const corrected = await read()
    assert(
      completed(corrected) < 12 && completed(corrected) >= 8,
      'Current-version Undo deliberately removes several completed at-bats'
    )
    await rig.converge(0, 'deliberate-current-undo')
    await rig.capture('deliberate-current-undo')
    await isolated.setOfflineMode(true)
    await acceptedAction(async () => {
      await rig.pitch(1, 'Ball', true)
    })
    const beforeFinalOut = completed(await read())
    for (let strike = 0; strike < 3; strike++)
      await acceptedAction(async () => {
        await rig.pitch(1, 'Called Strike', true)
      })
    await wait(
      async () => completed(await read()) === beforeFinalOut + 1,
      'third out closes before ending the game'
    )
    await rig.tap(1, '^Open scoring menu$')
    await rig.tap(1, '^End Game$')
    await rig.tap(1, '^Confirm End Game$')
    await wait(
      async () =>
        (await read()).plays.some(play => play.about.atBatIndex === 9999),
      'game finalized'
    )
    const final = await read()
    await rig.pitch(0, 'Ball', true)
    await reconnect(final, 'stale-final-rewind-rejected')
    assert.equal((await rig.api.game(rig.fixture.ids.game)).status, 'final')
    await writeFile(
      rig.ctx.artifact('stale-tail-oracle.json'),
      JSON.stringify({ accepted, corrected, final }, null, 2)
    )
  } catch (error) {
    await rig.capture('stale-tail-failed')
    await writeFile(
      rig.ctx.artifact('stale-tail-failed.json'),
      JSON.stringify(await read(), null, 2)
    )
    throw error
  } finally {
    await isolated.setOfflineMode(false)
  }
}
