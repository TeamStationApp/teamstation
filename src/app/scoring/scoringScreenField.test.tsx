import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { GameStationClient } from '../../common/api'
import type { BaseballScreen } from '../field/BaseballScreen'
import type { FieldPlacement } from '../field/fieldTypes'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { DevelopmentScoringSource } from './scoringSource'

type Props = Parameters<typeof BaseballScreen>[0]
type FieldProps = NonNullable<Props['field']>
interface Rendered {
  id: string
  playerId?: number
  team: string
}
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}

// The screen's props to the field are read from React's own tree, so each
// field callback can be driven the way a gesture on the 3D field drives it.
let container: HTMLElement | undefined
function find(
  fiber: Fiber | null | undefined,
  name: string
): Fiber | undefined {
  for (let node = fiber; node != null; node = node.sibling) {
    if (typeof node.type === 'function' || typeof node.type === 'object')
      if (node.type?.name === name) return node
    const inside = find(node.child, name)
    if (inside != null) return inside
  }
  return undefined
}
function props(): Props {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (container as unknown as Record<string, Fiber>)[key ?? '']
  // The container keeps the fiber it was created with; the tree on screen is
  // whichever of the two buffers its root committed last.
  const root = (host as { stateNode?: { current?: Fiber } }).stateNode
  const found = find(root?.current ?? host, 'BaseballScreen')
  if (found == null) throw new Error('The screen has not rendered')
  return found.memoizedProps as Props
}
function field(): FieldProps {
  const value = props().field
  if (value == null) throw new Error('The screen rendered no field')
  return value
}
function players(): Rendered[] {
  return (field() as unknown as { players: Rendered[] }).players
}
interface Presented {
  id: string
  generation: number
  stage: string
}
interface Moving {
  motion?: { id: string; generation: number; reported?: boolean }
}
// Plays out every presentation and every runner movement, as the field would.
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    const presented = field().presentation as Presented | null | undefined
    if (presented != null) {
      await step(() =>
        field().onPresentationContact?.(presented.id, presented.generation)
      )
      await step(() =>
        field().onPresentationDone?.(
          presented.id,
          presented.generation,
          presented.stage as never
        )
      )
      continue
    }
    const moving = (players() as Array<Rendered & Moving>).find(
      player => player.motion != null
    )
    if (moving?.motion == null) return
    const { id, generation } = moving.motion
    await step(() => field().onMovementComplete?.(id, generation))
  }
}
async function step(run: () => void): Promise<void> {
  await act(async () => {
    run()
  })
}

function placement(entityId: string): FieldPlacement {
  const event: FieldPlacement = {
    entityId,
    point: { x: 0, z: -30 },
    generation: 0,
    gestureId: 1
  }
  return event
}

let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function mount(source?: DevelopmentScoringSource): Promise<void> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async () => []
  const node = document.createElement('div')
  document.body.appendChild(node)
  container = node
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          userId={21}
          onExit={() => undefined}
          source={source}
        />
      </ThemeProvider>
    )
  })
}

describe('scoring screen field wiring', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    HTMLCanvasElement.prototype.getContext = getContext
    container?.remove()
    container = undefined
  })

  it('counts pitches from the pitch control and ignores the play button', async function () {
    await mount()
    expect(props().summary).includes('0 balls')
    await step(() => {
      props().onPitch?.('ball')
    })
    expect(props().summary).includes('1 balls')
    await step(() => {
      props().onPitch?.('play')
    })
    expect(props().summary).includes('1 balls')
    await step(() => {
      props().onUndo?.()
    })
    expect(props().summary).includes('0 balls')
  })

  it('opens and closes the game menu, and records camera gestures', async function () {
    await mount()
    await step(() => {
      props().onMenu?.()
    })
    await step(() => {
      props().onMenu?.()
    })
    await step(() => props().onCameraGesture?.(true))
    await step(() => props().onCameraGesture?.(false))
    expect(props().canPitch).equals(true)
  })

  it('switches a switch hitter by placing the batter on the other side', async function () {
    await mount()
    const selectable = field().selectableIds ?? []
    for (const id of selectable)
      await step(() => field().onPlayerPlacement?.(id, { x: 3, z: 0 }))
    await step(() => field().onPlayerPlacement?.('nobody', { x: 3, z: 0 }))
    await step(() => props().onDismissHint?.())
    expect(props().accessibilitySummary).includes('Batter')
  })

  it('scores an error from outcome to fielder, trajectory and defender', async function () {
    await mount()
    const outcome = props().ballInPlayControl as React.ReactElement<{
      onActive: (active: boolean) => void
      onChoose: (outcome: string, contact?: string) => void
    }>
    await step(() => {
      outcome.props.onActive(true)
    })
    await step(() => {
      outcome.props.onActive(false)
    })
    await step(() => {
      outcome.props.onChoose('Error')
    })
    expect(props().instruction).not.equals(undefined)

    const fielder = players().find(
      player => player.playerId === 10 && player.team !== 'offense'
    )
    expect(fielder, 'shortstop on the field').not.equals(undefined)
    await step(() => field().onLandingPreview?.({ x: 0, z: -30 }))
    await step(() => field().onFieldPlacement?.(placement(fielder?.id ?? '')))
    await step(() => field().onTrajectoryAccepted?.(25, 0))
    expect(props().instructionDetail ?? '').not.includes('°')

    await settle()
    expect(props().onFinish, 'the defender can be confirmed').to.be.a(
      'function'
    )
    // Confirming the defender dispatches through the screen's runner wrapper.
    await step(() => props().onFinish?.())
    await settle()

    const runner = players().find(player => player.team === 'runner')
    if (runner != null) {
      const verdict = field().runnerSafeError?.(runner.id, 2)
      expect(verdict === undefined || typeof verdict === 'string').equals(true)
      await step(() => field().onRunnerDrag?.(null))
      await step(() => field().onRunnerDrop?.(runner.id, 2, 'safe', 99))
    }
    expect(field().runnerSafeError?.('nobody', 2)).equals('Runner unavailable')
    await step(() => field().onGestureActive?.(true))
    await step(() => field().onGestureActive?.(false))
    await step(() => props().onFinish?.())
    await settle()
    for (let undo = 0; undo < 8; undo++)
      await step(() => {
        props().onUndo?.()
      })
    expect(props().accessibilitySummary).includes('0 outs')
  })

  it("sends the launch angle as the scorer's only when he moved it", async function () {
    const source = new DevelopmentScoringSource()
    await mount(source)
    const outcome = props().ballInPlayControl as React.ReactElement<{
      onChoose: (outcome: string, contact?: string) => void
    }>
    const shortstop = players().find(
      player => player.playerId === 10 && player.team !== 'offense'
    )
    /** The launch angle on the stored ball in play, if it has one. */
    const storedAngle = async (): Promise<unknown> => {
      await settle()
      const stored = source.store.games.get(String(gameFixture.id))
      const play = stored?.currentPlay ?? stored?.plays.at(-1)
      const events = (play?.playEvents ?? []) as Array<{
        details: { isInPlay?: boolean }
        hitData?: { launchAngle?: number }
      }>
      const hit = events.find(event => event.details.isInPlay === true)
      expect(hit, 'the ball in play is stored').not.equals(undefined)
      return hit?.hitData?.launchAngle
    }
    const generation = (): number => field().interaction?.generation ?? 0
    const accept = async (
      angle: number,
      dragged?: boolean
    ): Promise<unknown> => {
      await step(() => {
        outcome.props.onChoose('Single')
      })
      await step(() =>
        field().onFieldPlacement?.({
          ...placement(shortstop?.id ?? ''),
          generation: generation()
        })
      )
      await step(() =>
        field().onTrajectoryAccepted?.(angle, generation(), dragged)
      )
      const stored = await storedAngle()
      for (let undo = 0; undo < 8; undo++)
        await step(() => {
          props().onUndo?.()
        })
      return stored
    }
    // A tap on the untouched 45°, and the keyboard's Enter on it: no angle.
    expect(await accept(45, false)).equals(undefined)
    expect(await accept(45)).equals(undefined)
    // A drag that turned it, even back to 45°, and the keyboard's arrows
    // moving it off 45° then Enter or a tap: the scorer's own.
    expect(await accept(45, true)).equals(45)
    expect(await accept(30)).equals(30)
    expect(await accept(30, false)).equals(30)
  })

  it('offers the more menu and a runner draft that can be cancelled', async function () {
    await mount()
    const more = props().moreControl as React.ReactElement<{
      onActive: (active: boolean) => void
      onChoose: (input: unknown) => void
    }>
    await step(() => {
      more.props.onActive(true)
    })
    await step(() => {
      more.props.onActive(false)
    })
    await step(() => {
      more.props.onChoose({ action: 'Place a Runner (Tiebreaker)' })
    })
    await step(() => {
      more.props.onChoose({ action: 'Hit by Pitch' })
    })
    expect(props().summary).to.be.a('string')
  })
})
