import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ScoringSession } from '../../common/scoring/session'
import type { ScoringUpdate } from '../../common/scoring/updates'
import { ThemeProvider } from '../theme/ThemeContext'
import { RemoteScoringUpdates } from './RemoteScoringUpdates'
import { scoringPreferences } from './scoringPreferences'

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
})
function fixture(): {
  game: ScoringSession
  update: (id: string, userId?: string) => Promise<void>
  echo: () => Promise<void>
} {
  const listeners = new Set<() => void>()
  const game = {
    gameId: 'game-a',
    scoringUpdates: [] as ScoringUpdate[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  return {
    game: game as unknown as ScoringSession,
    async update(id: string, userId = 'other') {
      await act(async () => {
        game.scoringUpdates = [
          ...game.scoringUpdates,
          {
            id,
            sequence: game.scoringUpdates.length + 1,
            userId,
            name: 'Mike T.',
            lines: ['Top 1: Ball', 'Undo — Top 1: Called strike']
          }
        ]
        for (const listener of listeners) listener()
      })
    },
    async echo() {
      await act(async () => {
        for (const listener of listeners) listener()
      })
    }
  }
}
async function render(
  game: ScoringSession,
  userId = 'remote-panel-test',
  height = 620
): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <RemoteScoringUpdates
          game={game}
          userId={userId}
          width={393}
          height={height}
          undoWidth={150}
          undoTop={470}
          catcher={{ x: 170, y: 350, width: 40, height: 30 }}
        />
      </ThemeProvider>
    )
  })
}
const panel = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="remote-scoring-updates"]')
async function tap(label: string): Promise<void> {
  await act(async () => {
    host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
  })
}
describe('remote scoring update panel', () => {
  it('ignores initial history, own acknowledgments and duplicate delivery, but shows named remote plays and Undo', async () => {
    const f = fixture()
    await f.update('initial')
    await render(f.game)
    expect(panel()).equals(null)
    await f.update('own', 'remote-panel-test')
    expect(panel()).equals(null)
    await f.update('peer')
    expect(panel()!.textContent)
      .contains('Mike T.')
      .and.contains('Undo — Top 1: Called strike')
    await tap('Dismiss scoring updates')
    await f.echo()
    expect(panel()).equals(null)
    await f.update('next')
    expect(panel()).not.equals(null)
  })
  it('remembers collapse across dismissal, new updates and remounts', async () => {
    const f = fixture()
    await render(f.game, 'collapse-test')
    await f.update('1')
    await tap('Collapse scoring updates')
    expect(panel()!.style.width).equals('96px')
    expect(panel()!.textContent).not.contains('Top 1')
    await tap('Dismiss scoring updates')
    await f.update('2')
    expect(
      host.querySelector('[aria-label="Expand scoring updates"]')
    ).not.equals(null)
    expect(
      (await scoringPreferences.read('collapse-test')).remoteUpdatesCollapsed
    ).equals(true)
    await tap('Expand scoring updates')
    await tap('Dismiss scoring updates')
    await f.update('3')
    expect(
      host.querySelector('[aria-label="Collapse scoring updates"]')
    ).not.equals(null)
    await tap('Collapse scoring updates')
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    root = undefined
    await render(f.game, 'collapse-test')
    await f.update('4')
    expect(
      host.querySelector('[aria-label="Expand scoring updates"]')
    ).not.equals(null)
  })
  it('clears history on game/account changes and bounds expanded content to five lines', async () => {
    const f = fixture()
    await render(f.game, 'scroller-test', 400)
    for (let i = 0; i < 6; i++) await f.update(String(i))
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    expect(Number.parseFloat(lines.style.maxHeight)).at.most(100)
    expect(panel()!.style.width).equals('369px')
    expect(Number.parseFloat(panel()!.style.top)).at.most(400 - 64)
    await render(f.game, 'another-account')
    expect(panel()).equals(null)
    const other = fixture()
    await render(other.game, 'another-account')
    await f.update('old-game')
    expect(panel()).equals(null)
    await other.update('new-game')
    expect(panel()).not.equals(null)
  })
})
