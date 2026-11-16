import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { PlanInning, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GameSocketEvent } from '../../common/gameSocket'
import { CachingClient } from '../sync/cachingClient'
import {
  gameSaved,
  type PlanInningsOptions,
  planTeamsOf,
  usePlanInnings
} from './planInning'
import type { GameChanges } from './rosterLive'
import type { InningStart, ScoringEvent } from './scoringTypes'

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

  async plans(teamId: string, inning: number): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners])
        listener({
          type: 'change',
          gameId: 'g1',
          kind: 'plans',
          at: '2026-10-12T12:00:00Z',
          data: { teamId, inning }
        })
    })
    await settle()
  }
}

let root: Root | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function settle(ms = 5): Promise<void> {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
}

interface Call {
  teamId: string
  inning: number
  signal?: AbortSignal
}

/**
 * The hook in a component of its own, against a client whose `planInning`
 * answers what `answer` does, with every call kept.
 */
function harness(answer: (call: Call) => Promise<PlanInning>): {
  calls: Call[]
  applied: Array<Extract<ScoringEvent, { type: 'PLAN_INNING' }>>
  changes: FakeChanges
  state: {
    inning: number
    saved: boolean
    failed: boolean
    busy: boolean
    saves: number
  }
  shown: () => ReturnType<typeof usePlanInnings>
  render: (props: Partial<PlanInningsOptions>) => Promise<void>
} {
  const calls: Call[] = []
  const applied: Array<Extract<ScoringEvent, { type: 'PLAN_INNING' }>> = []
  const changes = new FakeChanges()
  const state = {
    inning: 1,
    saved: true,
    failed: false,
    busy: false,
    saves: 0
  }
  const client = {
    planInning: async (
      _gameId: string,
      teamId: string,
      inning: number,
      options: { signal?: AbortSignal } = {}
    ) => {
      const call = { teamId, inning, signal: options.signal }
      calls.push(call)
      return await answer(call)
    }
  } as unknown as TeamStationClient
  let latest: ReturnType<typeof usePlanInnings> | undefined
  function Probe(props: Partial<PlanInningsOptions>): null {
    latest = usePlanInnings({
      enabled: true,
      client,
      gameId: 'g1',
      teams: {
        away: { id: 'tem_owls', name: 'Owls' },
        home: { id: 'tem_hawks', name: 'Hawks' }
      },
      currentInning: () => state.inning,
      saved: async () => {
        state.saves++
        return state.failed ? 'failed' : state.saved ? 'saved' : 'offline'
      },
      socket: changes,
      apply: event => {
        if (state.busy) return false
        applied.push(event)
        return true
      },
      scoring: state.busy,
      ...props
    })
    return null
  }
  return {
    calls,
    applied,
    changes,
    state,
    shown: () => latest!,
    render: async props => {
      if (root == null) {
        const node = document.createElement('div')
        document.body.appendChild(node)
        root = createRoot(node)
      }
      await act(async () => {
        root?.render(<Probe {...props} />)
      })
      await settle()
    }
  }
}

const answered =
  (cells: Record<string, number>) =>
  async (call: Call): Promise<PlanInning> => ({
    teamId: call.teamId,
    inning: call.inning,
    column:
      cells[call.teamId] == null
        ? []
        : [
            {
              player: {
                gumboId: cells[call.teamId],
                fullName: 'P',
                jersey: '1'
              },
              cell: 'P'
            }
          ]
  })

const entered = (inning: number, id: number): InningStart => ({ inning, id })

/** An answer that never comes until its signal aborts it. */
const hangs = async (call: Call): Promise<PlanInning> =>
  await new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

describe('plan innings', function () {
  it('asks once per side for each inning entered, with a signal, only after the save, and applies what lands', async function () {
    const h = harness(answered({ tem_hawks: 10 }))
    await h.render({})
    expect(h.calls).deep.equals([])
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls.map(call => [call.teamId, call.inning])).deep.equals([
      ['tem_owls', 2],
      ['tem_hawks', 2]
    ])
    expect(h.calls.every(call => call.signal instanceof AbortSignal)).equals(
      true
    )
    expect(h.applied.map(event => [event.side, event.inning])).deep.equals([
      ['away', 2],
      ['home', 2]
    ])
    // Drawn again with the same inning entered, nothing is asked again.
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls).has.length(2)
    // The same inning entered again, after an Undo and back, is.
    await h.render({ inningStart: entered(2, 3) })
    expect(h.calls).has.length(4)
  })

  it('asks for nothing when the game could not be saved, when off, or with no teams', async function () {
    const h = harness(answered({}))
    h.state.saved = false
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls).deep.equals([])
    h.state.saved = true
    await h.render({ inningStart: entered(2, 2), enabled: false })
    await h.render({ inningStart: entered(2, 3), teams: undefined })
    expect(h.calls).deep.equals([])
    expect(h.shown().cards).deep.equals([])
  })

  it('drops an answer that lands after the game left its inning, and a failure then shows nothing', async function () {
    let finish: (() => void) | undefined
    const h = harness(
      async call =>
        await new Promise((resolve, reject) => {
          finish = () => {
            if (call.teamId === 'tem_owls')
              reject(new HttpError('internal', 'Down'))
            else
              resolve({ teamId: call.teamId, inning: call.inning, column: [] })
          }
        })
    )
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    h.state.inning = 3
    finish?.()
    await settle()
    expect(h.applied).deep.equals([])
    expect(h.shown().cards).deep.equals([])
  })

  it('shows a card when the download runs out of its time, and Try again asks once more', async function () {
    let answer = hangs
    const h = harness(async call => await answer(call))
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1), timeoutMs: 20 })
    await settle(15)
    expect(h.calls.every(call => call.signal?.aborted === true)).equals(true)
    expect(h.shown().cards).deep.equals([
      { side: 'away', inning: 2, teamName: 'Owls' },
      { side: 'home', inning: 2, teamName: 'Hawks' }
    ])
    answer = answered({ tem_hawks: 10 })
    await act(async () => {
      h.shown().retry(h.shown().cards[1])
    })
    await settle()
    expect(h.calls.slice(2).map(call => call.teamId)).deep.equals(['tem_hawks'])
    expect(h.applied.map(event => event.side)).deep.equals(['home'])
    expect(h.shown().cards).deep.equals([
      { side: 'away', inning: 2, teamName: 'Owls' }
    ])
    await act(async () => {
      h.shown().accept(h.shown().cards[0])
    })
    expect(h.shown().cards).deep.equals([])
    expect(h.calls).has.length(3)
  })

  it('shows nothing for a refusal before the start time or once the game is over, and a card for any other', async function () {
    for (const [reason, carded] of [
      ['planNotStarted', false],
      ['planGameOver', false],
      ['planInningNotCurrent', true]
    ] as const) {
      const h = harness(async () => {
        throw new HttpError(
          reason === 'planInningNotCurrent' ? 'conflict' : 'forbidden',
          'No',
          { reason }
        )
      })
      h.state.inning = 2
      await h.render({ inningStart: entered(2, 1) })
      expect(h.shown().cards.length > 0, reason).equals(carded)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
    }
  })

  it('downloads the inning in play when a coach changes it, and nothing for another inning, another team or when off', async function () {
    const h = harness(answered({ tem_hawks: 10 }))
    h.state.inning = 3
    await h.render({})
    await h.changes.plans('tem_hawks', 3)
    expect(h.calls.map(call => [call.teamId, call.inning])).deep.equals([
      ['tem_hawks', 3]
    ])
    expect(h.applied.map(event => [event.side, event.inning])).deep.equals([
      ['home', 3]
    ])
    await h.changes.plans('tem_hawks', 4)
    await h.changes.plans('tem_nobody', 3)
    await h.render({ enabled: false })
    await h.changes.plans('tem_owls', 3)
    expect(h.calls).has.length(1)
  })

  it('waits for the game’s save once for both sides of an inning entered, and asks for no inning past the last a plan may have', async function () {
    const h = harness(answered({}))
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    expect(h.state.saves).equals(1)
    expect(h.calls).has.length(2)
    h.state.inning = 13
    await h.render({ inningStart: entered(13, 2) })
    await h.changes.plans('tem_hawks', 13)
    expect(h.calls).has.length(2)
  })

  it('holds a column that lands while the screen is busy, applies it once the screen is at rest in that inning, and drops it once the inning has passed', async function () {
    const h = harness(answered({ tem_hawks: 10 }))
    h.state.inning = 2
    h.state.busy = true
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls).has.length(2)
    expect(h.applied).deep.equals([])
    // Still busy: offered again, still held.
    await h.render({ inningStart: entered(2, 1), scoring: 'pitch' })
    expect(h.applied).deep.equals([])
    h.state.busy = false
    await h.render({ inningStart: entered(2, 1), scoring: 'rest' })
    expect(h.applied.map(event => [event.side, event.inning])).deep.equals([
      ['away', 2],
      ['home', 2]
    ])
    // Applied once: offered no more.
    await h.render({ inningStart: entered(2, 1), scoring: 'later' })
    expect(h.applied).has.length(2)
    // Held into another inning, it goes unapplied.
    h.state.busy = true
    await h.changes.plans('tem_hawks', 2)
    h.state.inning = 3
    h.state.busy = false
    await h.render({ inningStart: entered(2, 1), scoring: 'next inning' })
    expect(h.applied).has.length(2)
  })

  it('takes back a side’s card once a later download of its column succeeds, and a slower failure behind it adds none', async function () {
    // The inning entered times out; the coach's change then gets through.
    let slow = true
    const h = harness(async call =>
      slow && call.teamId === 'tem_hawks'
        ? await hangs(call)
        : await answered({ tem_hawks: 10 })(call)
    )
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1), timeoutMs: 20 })
    await settle(15)
    expect(h.shown().cards.map(card => card.side)).deep.equals(['home'])
    slow = false
    await h.changes.plans('tem_hawks', 2)
    expect(h.shown().cards).deep.equals([])
    expect(h.applied.map(event => event.side)).deep.equals(['away', 'home'])

    // Overlapping: the inning entered hangs, the coach's change succeeds,
    // and only then does the first time out.
    slow = true
    h.state.inning = 3
    await h.render({ inningStart: entered(3, 2), timeoutMs: 200 })
    slow = false
    await h.changes.plans('tem_hawks', 3)
    await settle(60)
    expect(h.shown().cards).deep.equals([])
    expect(
      h.applied.filter(event => event.inning === 3).map(event => event.side)
    ).deep.equals(['away', 'home'])
  })

  it('drops a column that lands after a newer one for the same side and inning, so a coach’s change stays on the field', async function () {
    let release: (() => void) | undefined
    let first = true
    const h = harness(async call => {
      if (call.teamId !== 'tem_hawks') return await answered({})(call)
      if (first) {
        first = false
        // The inning entered's request, read before the coach's save.
        await new Promise<void>(resolve => {
          release = resolve
        })
        return {
          teamId: call.teamId,
          inning: call.inning,
          column: [
            {
              player: { gumboId: 10, fullName: 'Old', jersey: '1' },
              cell: 'C'
            }
          ]
        }
      }
      return await answered({ tem_hawks: 10 })(call)
    })
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    await h.changes.plans('tem_hawks', 2)
    release?.()
    await settle()
    const home = h.applied.filter(event => event.side === 'home')
    expect(home.map(event => event.column[0].cell)).deep.equals(['P'])
  })

  it('shows each side’s card when the game’s save failed, asks for nothing, and Try again asks once the save has gone through', async function () {
    const h = harness(answered({ tem_hawks: 10 }))
    h.state.inning = 2
    h.state.failed = true
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls).deep.equals([])
    expect(h.shown().cards.map(card => card.side)).deep.equals(['away', 'home'])
    h.state.failed = false
    await act(async () => {
      h.shown().retry(h.shown().cards[1])
    })
    await settle()
    expect(h.calls.map(call => call.teamId)).deep.equals(['tem_hawks'])
    expect(h.applied.map(event => event.side)).deep.equals(['home'])
    expect(h.shown().cards.map(card => card.side)).deep.equals(['away'])
  })

  it('keeps a newer request’s failure card when an older request’s column lands after it, and applies nothing stale', async function () {
    let release: (() => void) | undefined
    let first = true
    const h = harness(async call => {
      if (call.teamId !== 'tem_hawks') return await answered({})(call)
      if (first) {
        first = false
        // The inning entered's request, read before the coach's save.
        await new Promise<void>(resolve => {
          release = resolve
        })
        return await answered({ tem_hawks: 10 })(call)
      }
      // The coach's change: its download fails.
      throw new HttpError('internal', 'Down')
    })
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    await h.changes.plans('tem_hawks', 2)
    expect(h.shown().cards.map(card => card.side)).deep.equals(['home'])
    release?.()
    await settle()
    expect(h.applied.filter(event => event.side === 'home')).deep.equals([])
    expect(h.shown().cards.map(card => card.side)).deep.equals(['home'])
  })

  it('aborts a download still out when the screen closes, and applies nothing after', async function () {
    const h = harness(hangs)
    h.state.inning = 2
    await h.render({ inningStart: entered(2, 1) })
    expect(h.calls).has.length(2)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await settle()
    expect(h.calls.every(call => call.signal?.aborted === true)).equals(true)
    expect(h.applied).deep.equals([])
  })
})

describe('plan innings’ save check and teams', function () {
  const plain = {} as unknown as TeamStationClient
  const game = (
    changes: Partial<{
      readOnly: boolean
      pending: number
      fails: boolean
    }> = {}
  ): {
    flush: () => Promise<void>
    readOnly: boolean
    offline: boolean
    saveFailure: string | null
    pending: number
  } => ({
    flush: async () => {
      if (changes.fails === true) throw new Error('offline')
    },
    readOnly: changes.readOnly ?? false,
    offline: false,
    saveFailure: null,
    pending: changes.pending ?? 0
  })
  /** A phone's client whose outbox holds `chain` rows for the game. */
  const phone = (chain: number, held = false): TeamStationClient => {
    const client = Object.create(CachingClient.prototype) as CachingClient
    let drained = 0
    Object.assign(client, {
      drainOutbox: async () => {
        drained++
      },
      outboxSummary: async () => ({
        chains: chain > 0 ? { 'game:g1': chain } : {},
        games: held ? { g1: { reason: 'refused' } } : {},
        drained: () => drained
      })
    })
    return client
  }

  it('is saved once the session has nothing pending, and on a phone once its outbox drained for the game', async function () {
    expect(await gameSaved(game(), plain, 'g1')).equals('saved')
    expect(await gameSaved(game(), phone(0), 'g1')).equals('saved')
  })

  it('flushes again while plays scored meanwhile are still going out', async function () {
    let pending = 2
    const busy = {
      flush: async () => {
        pending = Math.max(0, pending - 1)
      },
      readOnly: false,
      offline: false,
      saveFailure: null,
      get pending() {
        return pending
      }
    }
    expect(await gameSaved(busy, plain, 'g1')).equals('saved')
    expect(pending).equals(0)
  })

  it('answers offline or failed after the one flush whose save failed, leaving the retries to the session', async function () {
    for (const [offline, saveFailure, answer] of [
      [true, null, 'offline'],
      [false, 'Internal error', 'failed']
    ] as const) {
      let flushes = 0
      const failing = {
        flush: async () => {
          flushes++
        },
        readOnly: false,
        offline,
        saveFailure,
        pending: 3
      }
      expect(await gameSaved(failing, plain, 'g1'), answer).equals(answer)
      expect(flushes, answer).equals(1)
    }
  })

  it('keeps flushing while a save succeeds and a play finished meanwhile leaves as much pending', async function () {
    let flushes = 0
    const scoring = {
      flush: async () => {
        flushes++
      },
      readOnly: false,
      offline: false,
      saveFailure: null,
      get pending() {
        // A play finished during the first flush: still 2 after it.
        return flushes < 2 ? 2 : 0
      }
    }
    expect(await gameSaved(scoring, plain, 'g1')).equals('saved')
    expect(flushes).equals(2)
  })

  it('is not saved when the save fails, is refused, has plays pending, or the phone still holds the game', async function () {
    expect(await gameSaved(game({ fails: true }), plain, 'g1')).equals('failed')
    expect(await gameSaved(game({ readOnly: true }), plain, 'g1')).equals(
      'offline'
    )
    expect(await gameSaved(game({ pending: 1 }), plain, 'g1')).equals('failed')
    expect(await gameSaved(game(), phone(2), 'g1')).equals('offline')
    expect(await gameSaved(game(), phone(0, true), 'g1')).equals('offline')
  })

  it('names the teams the screen opened on by side, and none for a game not opened from the server', function () {
    const names = { away: { name: 'Owls' }, home: { name: 'Hawks' } }
    expect(
      planTeamsOf({ awayTeamId: 'tem_o', homeTeamId: 'tem_h' }, names)
    ).deep.equals({
      away: { id: 'tem_o', name: 'Owls' },
      home: { id: 'tem_h', name: 'Hawks' }
    })
    expect(planTeamsOf(undefined, names)).equals(undefined)
  })
})
