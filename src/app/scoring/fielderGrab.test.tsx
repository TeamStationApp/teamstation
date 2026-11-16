import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { type RosterEntry, TeamStationClient } from '../../common/api'
import { ScoringSession } from '../../common/scoring/session'
import { scoringRoster, scoringSession } from '../../test/scoringSession'
import type { BaseballScreen } from '../field/BaseballScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { memoryStore } from './scoringSource'

type Props = Parameters<typeof BaseballScreen>[0]
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}
let container: HTMLElement | undefined
function find(
  fiber: Fiber | null | undefined,
  name: string
): Fiber | undefined {
  for (let node = fiber; node != null; node = node.sibling) {
    if (
      (typeof node.type === 'function' || typeof node.type === 'object') &&
      node.type?.name === name
    )
      return node
    const inside = find(node.child, name)
    if (inside != null) return inside
  }
  return undefined
}
function props(): Props {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (
    container as unknown as Record<
      string,
      Fiber & { stateNode?: { current?: Fiber } }
    >
  )[key ?? '']
  return find(host.stateNode?.current ?? host, 'BaseballScreen')!
    .memoizedProps as Props
}
const field = (): NonNullable<Props['field']> => props().field
const step = async (run: () => void): Promise<void> => {
  await act(async () => {
    run()
  })
}

describe('the fielder a scorer grabs', function () {
  it('keeps the field players while a grab starts, with names the rosters carry and the game does not', async function () {
    const initial = scoringSession(gameFixture)
    // As a game read back from the server holds them: account players, with
    // no reader-only name fields; the rosters carry them.
    for (const player of Object.values(initial.gameData.players))
      player.local = false
    const live = ScoringSession.start(memoryStore(), 'g1', initial, {
      requireCurrentSetup: true
    })
    const formatted = (rows: RosterEntry[]): RosterEntry[] =>
      rows.map(row => ({
        ...row,
        nameFormat: 'full',
        compactName: row.shortName
      }))
    const rosters: Record<string, RosterEntry[]> = {
      away: formatted(scoringRoster(1)),
      home: formatted(scoringRoster(10))
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.roster = async teamId => rosters[teamId] ?? []
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            userId={21}
            onExit={() => undefined}
            source={{ persistent: false, open: async () => live }}
          />
        </ThemeProvider>
      )
    })
    const outcome = props().ballInPlayControl as React.ReactElement<{
      onChoose: (outcome: string) => void
    }>
    await step(() => {
      outcome.props.onChoose('Ball Caught')
    })
    expect(props().instruction).includes('where the ball was fielded')
    const before = field().players
    // The field scene raises the gesture flag as a pointer grabs a fielder;
    // a new players array then cancels that grab before the finger lifts.
    await step(() => field().onGestureActive?.(true))
    expect(field().players, 'the same players through the grab').equals(before)
    await act(async () => {
      root.unmount()
    })
    container.remove()
    HTMLCanvasElement.prototype.getContext = getContext
  })
})
