import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameLineupsResponse } from '../../common/api'
import type { GameSocketEvent } from '../../common/gameSocket'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor } from './RosterEditor'
import {
  type GameChanges,
  LineupDigests,
  listen,
  type RosterLive,
  useRosterLive
} from './rosterLive'
import { initialScoringState } from './scoringMachine'

const BANNER =
  'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'

describe('hearing a game', function () {
  it('hears nothing, and stops cleanly, where the socket cannot be had', function () {
    const stop = listen(
      {
        subscribe: () => {
          throw new Error('This platform has no WebSocket')
        }
      },
      'g1',
      () => undefined
    )
    stop()
  })
})

describe('lineups digests', function () {
  it('tells of a digest that differs from the kept one, once', function () {
    const foreign: string[] = []
    const digests = new LineupDigests(digest => foreign.push(digest))
    digests.hold()
    digests.answered('d1')
    digests.heard('d1')
    digests.heard('d2')
    digests.heard('d2')
    expect(foreign).deep.equals(['d2'])
  })

  it('holds what is heard while a read is out, and drops what was read', function () {
    const foreign: string[] = []
    const digests = new LineupDigests(digest => foreign.push(digest))
    digests.hold()
    digests.heard('d1')
    digests.answered('d1')
    expect(foreign).deep.equals([])
    digests.hold()
    digests.heard('read')
    digests.heard('later')
    expect(foreign).deep.equals([])
    digests.answered('read')
    expect(foreign).deep.equals(['later'])
  })

  it('drops all it heard while its own save was out, and hears it when the save fails', function () {
    const foreign: string[] = []
    const digests = new LineupDigests(digest => foreign.push(digest))
    digests.hold()
    digests.answered('d1')
    // The save replayed the game over theirs, then its own echo came.
    digests.hold()
    digests.heard('theirs')
    digests.heard('mine')
    digests.answered('mine', true)
    expect(foreign).deep.equals([])
    digests.heard('mine')
    expect(foreign).deep.equals([])
    // A save that failed keeps the digest it had, and hears what was held.
    digests.hold()
    digests.heard('theirs')
    digests.heard('again')
    digests.answered(undefined, true)
    expect(foreign).deep.equals(['theirs', 'again'])
  })
})

/** The game socket, as a test sends to it. */
class FakeChanges implements GameChanges {
  readonly listeners = new Set<(event: GameSocketEvent) => void>()

  subscribe(
    _gameId: string,
    listener: (event: GameSocketEvent) => void
  ): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async emit(event: GameSocketEvent): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners]) listener(event)
    })
    await settle()
  }

  async lineups(digest: string): Promise<void> {
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'lineups',
      at: '2026-10-12T12:00:00Z',
      data: { digest } as unknown as GameLineupsResponse
    })
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
}

describe('a roster screen following the lineups', function () {
  let root: Root | undefined
  let host: HTMLDivElement
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
  })
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )
  const node = (label: string): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  const click = async (label: string): Promise<void> => {
    const found = node(label)
    expect(found, label).not.equals(null)
    await act(async () => {
      found!.click()
    })
    await settle()
  }
  const banner = (): string | null =>
    host.querySelector('[data-testid="Roster conflict"]')?.textContent ?? null
  const lineup = (): number =>
    host.querySelectorAll('[aria-label^="Reorder "]').length
  /** The last batter taken out of the lineup: the draft is dirty. */
  const dirty = async (): Promise<void> => {
    const remove = [
      ...host.querySelectorAll<HTMLElement>('[aria-label^="Remove "]')
    ].at(-1)
    await act(async () => {
      remove!.click()
    })
    await settle()
  }

  /**
   * A roster screen as a scorekeeper's sheet or a coach's screen draws it,
   * following the socket from the start. A coach's Save waits on `save`.
   */
  async function mount(
    audience: 'scorekeeper' | 'coach',
    options: {
      save?: () => Promise<string>
      read?: () => Promise<string>
    } = {}
  ): Promise<{
    changes: FakeChanges
    reloads: () => number
    cancels: () => number
    live: () => RosterLive
  }> {
    const changes = new FakeChanges()
    let reloads = 0
    let cancels = 0
    let live: RosterLive | undefined
    function Screen(): React.ReactElement {
      const [changed, setChanged] = useState(false)
      const [read, setRead] = useState(0)
      const following = useRosterLive({
        socket: changes,
        gameId: 'g1',
        dirty: changed,
        read: options.read ?? (async () => 'd1'),
        onReload: () => {
          reloads++
          setRead(value => value + 1)
        }
      })
      live = following
      const { start, stop } = following
      useEffect(() => {
        start()
        return stop
      }, [start, stop])
      return (
        <RosterEditor
          key={read}
          state={state}
          audience={audience}
          {...(audience === 'coach' ? { fixedSide: 'away' as const } : {})}
          conflict={following.conflict}
          onDirtyChange={setChanged}
          onCancel={() => {
            cancels++
            following.clear()
          }}
          onReload={() => {
            following.clear()
            reloads++
            setRead(value => value + 1)
          }}
          onSave={() => {
            if (options.save != null) following.saving(options.save())
          }}
        />
      )
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Screen />
        </ThemeProvider>
      )
    })
    await settle()
    return {
      changes,
      reloads: () => reloads,
      cancels: () => cancels,
      live: () => live!
    }
  }

  it('reads a clean draft in again on another device’s change', async function () {
    const { changes, reloads } = await mount('scorekeeper')
    await changes.lineups('d1')
    expect(reloads()).equals(0)
    await changes.lineups('d2')
    expect(reloads()).equals(1)
    expect(banner()).equals(null)
  })

  it('warns over a dirty draft and keeps it; Cancel goes back to theirs', async function () {
    expect(lstrings.scoring_roster_conflict).equals(BANNER)
    const { changes, reloads, cancels } = await mount('scorekeeper')
    await dirty()
    expect(lineup()).equals(8)
    await changes.lineups('d2')
    expect(reloads()).equals(0)
    expect(banner()).equals(BANNER)
    expect(lineup()).equals(8)
    await click('Cancel')
    expect(cancels()).equals(1)
    expect(banner()).equals(null)
  })

  it('reads theirs in once a warned draft is clean again', async function () {
    const { changes, reloads } = await mount('scorekeeper')
    await dirty()
    await changes.lineups('d2')
    expect(banner()).equals(BANNER)
    // Back to the lineup it was opened with: the batter added at the end.
    const add = host.querySelector<HTMLElement>('[aria-label^="Add "]')
    await act(async () => {
      add!.click()
    })
    await settle()
    expect(banner()).equals(null)
    expect(reloads()).equals(1)
  })

  it('shows nothing for its own save, before or after the answer', async function () {
    let answer = (_digest: string): void => undefined
    const { changes, reloads } = await mount('coach', {
      save: async () =>
        await new Promise<string>(resolve => {
          answer = resolve
        })
    })
    await dirty()
    await click('Save Rosters')
    // Its echo arrives before the answer: held, and dropped.
    await changes.lineups('d2')
    expect(banner()).equals(null)
    await act(async () => {
      answer('d2')
    })
    await settle()
    expect(banner()).equals(null)
    expect(reloads()).equals(0)
    // And again after it.
    await changes.lineups('d2')
    expect(banner()).equals(null)
    expect(reloads()).equals(0)
  })

  it('drops another device’s change heard during its save, which was written over it', async function () {
    let answer = (_digest: string): void => undefined
    const { changes, reloads } = await mount('coach', {
      save: async () =>
        await new Promise<string>(resolve => {
          answer = resolve
        })
    })
    await dirty()
    await changes.lineups('d2')
    expect(banner()).equals(BANNER)
    await click('Save Rosters')
    await changes.lineups('d4')
    await changes.lineups('d3')
    expect(banner()).equals(BANNER)
    await act(async () => {
      answer('d3')
    })
    await settle()
    // The save cleared the warning, and nothing heard before it answered
    // raises it again or reads the game in a second time.
    expect(banner()).equals(null)
    expect(reloads()).equals(0)
    await changes.lineups('d3')
    expect(banner()).equals(null)
    expect(reloads()).equals(0)
    // Somebody else's change after it is heard.
    await changes.lineups('d5')
    expect(banner()).equals(BANNER)
  })

  it('clears the warning with a save, and keeps it when the save fails', async function () {
    let fail = true
    const { changes } = await mount('coach', {
      save: async () => {
        if (fail) throw new Error('offline')
        return 'd3'
      }
    })
    await dirty()
    await changes.lineups('d2')
    await click('Save Rosters')
    expect(banner()).equals(BANNER)
    fail = false
    await click('Save Rosters')
    expect(banner()).equals(null)
  })

  it('a coach’s Cancel discards and reads theirs in, once', async function () {
    const { changes, reloads } = await mount('coach')
    await dirty()
    await changes.lineups('d2')
    expect(banner()).equals(BANNER)
    await click('Cancel')
    expect(banner()).equals(null)
    expect(reloads()).equals(1)
    expect(lineup()).equals(9)
  })

  it('reads the digest again after a reconnect, and stops on close', async function () {
    let digest = 'd1'
    const { changes, reloads, live } = await mount('scorekeeper', {
      read: async () => digest
    })
    await changes.emit({ type: 'resync', gameId: 'g1' })
    expect(reloads()).equals(0)
    digest = 'd2'
    await changes.emit({ type: 'resync', gameId: 'g1' })
    expect(reloads()).equals(1)
    await act(async () => {
      live().stop()
    })
    await changes.lineups('d5')
    expect(reloads()).equals(1)
    // A save with nothing followed is not waited on.
    live().saving(Promise.resolve('d6'))
    await settle()
    await changes.lineups('d6')
    expect(reloads()).equals(1)
  })

  it('treats every change as another device’s when the first read fails', async function () {
    const { changes, reloads } = await mount('scorekeeper', {
      read: async () => {
        throw new Error('offline')
      }
    })
    await changes.lineups('d1')
    expect(reloads()).equals(1)
  })
})
