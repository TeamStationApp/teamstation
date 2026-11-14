import { afterEach } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ScoringAction } from '../../common/scoring/actions'
import type { RemovalRecord } from '../../common/scoring/authorship'
import {
  type AcceptedPicture,
  applyAction,
  type ScoringSession
} from '../../common/scoring/session'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { RemoteScoringUpdates } from './RemoteScoringUpdates'

/** The remote scoring panel's fake session and renderer, shared by its specs. */
let root: Root | undefined
export let host: HTMLDivElement
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
})
/** How long the panel's subscriber took on the last notification. */
export const timing = { lastNotifyMs: 0 }

/** What a removal removes in the fake stream unless a test says otherwise. */
const DEFAULT_REMOVED: ScoringAction = { type: 'pitch', call: 'C' }

/**
 * A fake session over a real game: `update` appends accepted actions by an
 * author and, by default, a removal, as a reload taking up somebody's save
 * would; `undo` removes accepted actions as an author's Undo does.
 */
export function fixture(_withState = true): {
  game: ScoringSession
  update: (
    id: string,
    userId?: string,
    actions?: ScoringAction[],
    notify?: boolean
  ) => Promise<void>
  undo: (count: number, userId?: string, notify?: boolean) => Promise<void>
  /** A reload of an unchanged history: new objects, reordered properties. */
  reread: () => Promise<void>
  echo: () => Promise<void>
} {
  const listeners = new Set<() => void>()
  const opening = scoringSession(gameFixture)
  let actions: ScoringAction[] = []
  let authors: Array<string | null> = []
  let state = opening
  let removals: RemovalRecord[] = []
  let names: Record<string, string> = {}
  let accepted: AcceptedPicture = {
    opening,
    actions,
    authors,
    state,
    removals,
    names
  }
  let alternate = 0
  const publish = (replay = false): void => {
    if (replay)
      state = actions.reduce(
        (game, action) => applyAction(game, action).state,
        opening
      )
    accepted = {
      opening,
      actions: [...actions],
      authors: [...authors],
      state,
      removals: [...removals],
      names: { ...names }
    }
  }
  const game = {
    opening,
    get state() {
      return state
    },
    get actions() {
      return actions
    },
    get accepted() {
      return accepted
    },
    gameId: 'game-a',
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const notifyAll = (): void => {
    const started = performance.now()
    for (const listener of listeners) listener()
    timing.lastNotifyMs = performance.now() - started
  }
  return {
    game: game as unknown as ScoringSession,
    async update(id, userId, added, notify = true) {
      await act(async () => {
        const author = userId ?? (alternate++ % 2 === 0 ? 'other' : 'other-b')
        names = { ...names, [author]: 'Mike T.' }
        const appended = added ?? [{ type: 'pitch', call: 'B' }]
        for (const action of appended) {
          if (applyAction(state, action).problems.length > 0)
            throw new Error(`${id}: ${JSON.stringify(action)} does not apply`)
          state = applyAction(state, action).state
          actions = [...actions, action]
          authors = [...authors, author]
        }
        if (added == null)
          removals = [
            ...removals,
            {
              id: `${id}-removal`,
              sequence: removals.length + 1,
              userId: author,
              atBatIndex: 0,
              actions: [DEFAULT_REMOVED]
            }
          ]
        publish()
        if (notify) notifyAll()
      })
    },
    async undo(count, userId = 'other', notify = true) {
      await act(async () => {
        names = { ...names, [userId]: 'Mike T.' }
        const removed = actions.slice(actions.length - count)
        actions = actions.slice(0, actions.length - count)
        authors = authors.slice(0, authors.length - count)
        removals = [
          ...removals,
          {
            id: `undo-${removals.length + 1}`,
            sequence: removals.length + 1,
            userId,
            atBatIndex: 0,
            actions: removed
          }
        ]
        publish(true)
        if (notify) notifyAll()
      })
    },
    async reread() {
      await act(async () => {
        actions = actions.map(
          action =>
            Object.fromEntries(
              Object.entries(action).reverse()
            ) as unknown as ScoringAction
        )
        publish()
        notifyAll()
      })
    },
    async echo() {
      await act(async () => {
        notifyAll()
      })
    }
  }
}
export async function render(
  game: ScoringSession,
  userId = 'remote-panel-test',
  height = 620,
  obscured = false,
  catcherY = 350
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
          obscured={obscured}
          undoWidth={150}
          undoTop={height - 64}
          catcher={{ x: 170, y: catcherY, width: 40, height: 30 }}
        />
      </ThemeProvider>
    )
  })
}
/** Unmounts and removes the panel, as leaving the scoring screen does. */
export async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  host.remove()
  root = undefined
}
export const panel = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="remote-scoring-updates"]')
export async function tap(label: string): Promise<void> {
  await act(async () => {
    host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
  })
}
