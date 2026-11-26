import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { replayBoxScore } from '../../common/replay/replayBoxScore'
import { replayTimelineOf } from '../../common/replay/replayTimeline'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import { scoringFrame } from '../field/scoringFrame'
import { ThemeProvider } from '../theme/ThemeContext'
import { fixture } from './remoteScoringFixture.test'
import { ScoringSidePanel } from './ScoringSidePanel'

describe('the scoring side column', function () {
  let root: Root
  let host: HTMLDivElement
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
  })
  it('keeps the accepted history on resize, and follows the local box through a pitch and its undo', async function () {
    const f = fixture()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const insets = { top: 0, left: 0, bottom: 0, right: 0 }
    const show = async (width: number, height: number): Promise<void> => {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSidePanel
              frame={scoringFrame({ width, height, insets, platform: 'web' })}
              row={{ left: 8, right: 8 }}
              insets={insets}
              state={f.game.state}
              updates={{ game: f.game, userId: 'side-column-reader' }}
            />
          </ThemeProvider>
        )
      })
    }
    const el = (id: string): HTMLElement | null =>
      host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const tap = async (label: string): Promise<void> => {
      await act(async () => {
        host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
      })
    }
    await show(1133, 744)
    expect(el('scoring-side')!.firstElementChild).equals(el('replay-box-score'))
    const before = el('replay-box-score')!.textContent
    const plays = f.game.state.liveData.plays.allPlays.length
    const pc = (): number | null =>
      replayBoxScore(f.game.state).home.pitching[0].pc
    const pitches = pc() ?? 0
    await f.update('peer', 'other', [{ type: 'pitch', call: 'B' }])
    await show(1133, 744)
    expect(pc()).equals(pitches + 1)
    expect(f.game.state.liveData.plays.allPlays.length).equals(plays)
    expect(el('replay-box-score')!.textContent).not.equals(before)
    expect(el('scoring-side')!.firstElementChild).equals(
      el('remote-scoring-updates')
    )
    expect(el('remote-scoring-update-lines')!.style.height).equals('20px')
    await tap('Collapse scoring updates')
    expect(el('remote-scoring-update-lines')).equals(null)
    await show(390, 844)
    expect(el('scoring-side')).equals(null)
    expect(el('remote-scoring-updates')).not.equals(null)
    await show(1133, 744)
    await tap('Expand scoring updates')
    expect(el('remote-scoring-update-lines')!.textContent).contains('Mike T.')
    await tap('Dismiss scoring updates')
    expect(el('scoring-side')!.firstElementChild).equals(el('replay-box-score'))
    await show(320, 568)
    await show(1133, 744)
    expect(el('remote-scoring-updates')).equals(null)
    await f.undo(1, 'other')
    await show(1133, 744)
    expect(el('replay-box-score')!.textContent).equals(before)
    expect(el('remote-scoring-updates')).not.equals(null)
    for (let i = 0; i < 12; i++)
      await f.update('foul-' + i, 'peer-' + i, [{ type: 'pitch', call: 'F' }])
    await show(1133, 744)
    expect(el('remote-scoring-update-lines')!.style.height).equals('160px')
  })
  it('reads the live pitcher substitution and corrected earlier pitch from the local game', async function () {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const insets = { top: 0, left: 0, right: 0, bottom: 0 }
    const frame = scoringFrame({
      width: 1133,
      height: 744,
      platform: 'web',
      insets
    })
    async function show(actions: ScoringAction[]): Promise<HTMLElement[]> {
      const state = replayTimelineOf(await scored(actions), replayContext()).end
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSidePanel
              frame={frame}
              insets={insets}
              row={{ left: 8, right: 8 }}
              state={state}
            />
          </ThemeProvider>
        )
      })
      return Array.from(
        host.querySelectorAll<HTMLElement>('[data-testid="replay-box-current"]')
      )
    }
    const actions = replayActions()
    const index = actions.findIndex(
      a => a.type === 'lineup' && a.kind === 'substitute'
    )
    const original = actions.slice(0, index)
    const before = await show(original)
    expect(
      before.some(row => row.textContent?.startsWith('Gerrit C') === true)
    ).equals(true)
    const subbed = await show(actions.slice(0, index + 1))
    expect(
      subbed.some(row => row.textContent?.startsWith('Luis G') === true)
    ).equals(true)
    const corrected = [...original]
    const pitch =
      corrected.findIndex(
        a => a.type === 'ballInPlay' && a.homeRunKind === 'out-of-park'
      ) - 1
    expect(pitch).at.least(0)
    expect(corrected[pitch]).includes({ type: 'pitch', call: 'C' })
    corrected[pitch] = { type: 'pitch', call: 'B' }
    const pitches = (rows: HTMLElement[]): string | null =>
      rows.find(row => row.children.length === 10)!.lastElementChild!
        .textContent
    const originalStrikes = pitches(await show(original))
    const correctedStrikes = pitches(await show(corrected))
    expect(Number(correctedStrikes)).equals(Number(originalStrikes) - 1)
    expect(pitches(await show(original))).equals(originalStrikes)
  })
})
