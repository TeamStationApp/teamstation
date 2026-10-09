import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { tagTargets } from '../../common/eventTags'
import { setupOf } from '../../common/scoring/state'
import { F } from '../../test/scoringGames'
import type { BaseballScreen } from '../field/BaseballScreen'
import type { FieldPlacement } from '../field/fieldTypes'
import { ThemeProvider } from '../theme/ThemeContext'
import type { EventTagEditor } from './EventTagEditor'
import { gameFixture } from './isUnscoredGame.test'
import { scoringClock } from './scoringClock'
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
function componentProps<T>(name: string): T {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (container as unknown as Record<string, Fiber>)[key ?? '']
  // The container keeps the fiber it was created with; the tree on screen is
  // whichever of the two buffers its root committed last.
  const root = (host as { stateNode?: { current?: Fiber } }).stateNode
  const found = find(root?.current ?? host, name)
  if (found == null) throw new Error('The screen has not rendered')
  return found.memoizedProps as T
}
function props(): Props {
  return componentProps<Props>('BaseballScreen')
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
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
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

  for (const change of ['close', 'reselect', 'account', 'unmount'] as const)
    it(`does not issue a tag request after ${change} while scoring flush is pending`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const document = source.store.games.get('g1')?.currentPlay
      expect(document).not.equals(null)
      const target = tagTargets(document!)[0]
      await step(() => {
        props().onTagSelect?.(target)
      })
      const editor =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      const panel = componentProps<{
        game: { flush: () => Promise<void> }
        client: TeamStationClient
      }>('ScoringPanel')
      let release!: () => void
      panel.game.flush = async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      let calls = 0
      source.saveTag = async (_game, targetId, tag) => {
        calls++
        return { targetId, tag, revision: '1' }
      }
      const saving = editor
        .saveTag('great catch')
        .catch((error: unknown) => error)
      if (change === 'unmount') {
        await act(async () => {
          root?.unmount()
        })
        root = undefined
      } else if (change === 'account') {
        panel.client.token = 'changed-account-test-token'
      } else {
        await step(() => {
          editor.onClose()
        })
        if (change === 'reselect')
          await step(() => {
            props().onTagSelect?.(target)
          })
      }
      release()
      const result = await saving
      expect(result).instanceOf(Error)
      expect((result as Error).message).includes('tag selection changed')
      expect(calls).equals(0)
    })

  it('keeps a pitch description when a deferred batting-team roster change is the newest Undo action', async () => {
    const source = new DevelopmentScoringSource()
    const original = await source.open(gameFixture, [], [])
    original.apply({ type: 'pitch', call: 'B' })
    const setup = setupOf(original.state)
    const defense = setup.sides.away.defense
    ;[defense.P, defense.SS] = [defense.SS, defense.P]
    original.apply({ type: 'lineup', kind: 'roster', setup })
    await original.flush()
    const target = original.eventTargets[0]
    await mount(source)
    expect(props().historyDetail?.primary).equals('Roster changed')
    await step(() => {
      props().onHistoryOpen?.()
    })
    expect(props().historyRows).has.length(1)
    expect(props().historyRows![0]).deep.includes({
      id: target.id,
      title: 'Ball',
      description: 'Ball'
    })
    expect(props().tagHistoryDetail).equals(undefined)
    await step(() => {
      props().onTagSelect?.(props().historyRows![0])
    })
    const editor =
      componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
    expect(editor.target.description).equals('Ball')
    await editor.saveTag('pitch label')
    expect(
      tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
    ).deep.includes({ id: target.id, tag: 'pitch label' })
  })

  it('tags the visible resumed ball rather than the stored unfinished in-play pitch', async () => {
    const source = new DevelopmentScoringSource()
    const original = await source.open(gameFixture, [], [])
    original.apply({ type: 'pitch', call: 'B' })
    original.apply({
      type: 'ballInPlay',
      contact: 'swing',
      location: { x: 0, z: -30 },
      fielder: F.CF
    })
    await original.flush()
    const targets = original.eventTargets
    expect(targets).has.length(2)
    await mount(source)
    await step(() => {
      props().onHistoryOpen?.()
    })
    const visible = props().historyRows!
    expect(visible).has.length(1)
    expect(visible[0].id).equals(targets[0].id)
    expect(visible[0].title).equals('Ball')
    await step(() => {
      props().onTagSelect?.(visible[0])
    })
    await componentProps<Parameters<typeof EventTagEditor>[0]>(
      'EventTagEditor'
    ).saveTag('correct pitch')
    const stored = tagTargets(source.store.games.get('g1')!.currentPlay!)
    expect(stored[0]).deep.includes({ id: targets[0].id, tag: 'correct pitch' })
    expect(stored[1].tag).equals(null)
  })

  it('reconciles a successful dismissed save into current history without reopening the editor', async () => {
    const source = new DevelopmentScoringSource()
    await mount(source)
    await step(() => {
      props().onPitch?.('ball')
    })
    await settle()
    const target = tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
    let finish!: () => void
    const save = source.saveTag.bind(source)
    source.saveTag = async (...args) => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return await save(...args)
    }
    await step(() => {
      props().onTagSelect?.(target)
    })
    const editor =
      componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
    let saving!: Promise<void>
    await act(async () => {
      saving = editor.saveTag('great pitch')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await step(() => {
      editor.onClose()
    })
    await act(async () => {
      finish()
      await saving
    })
    expect(
      tagTargets(source.store.games.get('g1')!.currentPlay!)[0].tag
    ).equals('great pitch')
    expect(container?.textContent).not.includes('New tag')
    await step(() => {
      props().onHistoryOpen?.()
    })
    expect(props().historyRows![0].tag).equals('great pitch')
    await step(() => {
      props().onTagSelect?.(props().historyRows![0])
    })
    expect(
      componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
        .target.tag
    ).equals('great pitch')
    expect(document.body.textContent).includes('Remove tag')
  })

  for (const order of ['response', 'commit'] as const)
    it(`reconciles committed tags when A's ${order} follows B on the same target`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
      const finish = new Map<string, () => void>()
      const save = source.saveTag.bind(source)
      source.saveTag = async (...args) => {
        const label = args[2]!
        const gate = async (): Promise<void> => {
          await new Promise<void>(resolve => {
            finish.set(label, resolve)
          })
        }
        if (order === 'commit' && label === 'older label') await gate()
        const result = await save(...args)
        if (order === 'response' || label === 'newer label') await gate()
        return result
      }
      await step(() => {
        props().onTagSelect?.(target)
      })
      const older =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let oldSave!: Promise<unknown>
      await act(async () => {
        oldSave = older.saveTag('older label').catch((error: unknown) => error)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        older.onClose()
        props().onTagSelect?.(target)
      })
      const newer =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let newSave!: Promise<void>
      await act(async () => {
        newSave = newer.saveTag('newer label')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await act(async () => {
        finish.get('newer label')!()
        await newSave
      })
      const game = componentProps<{
        game: { eventTargets: Array<typeof target> }
      }>('ScoringPanel').game
      expect(game.eventTargets[0].tag).equals('newer label')
      await act(async () => {
        finish.get('older label')!()
        await oldSave
      })
      const expected = order === 'commit' ? 'older label' : 'newer label'
      expect(game.eventTargets[0].tag).equals(expected)
      expect(
        tagTargets(source.store.games.get('g1')!.currentPlay!)[0].tag
      ).equals(expected)
    })

  it('resumes the correction countdown after history dismissal and tag save', async function () {
    const original = { ...scoringClock }
    let time = 0
    let serial = 0
    const timers = new Map<number, () => void>()
    scoringClock.now = () => time
    scoringClock.schedule = callback => {
      timers.set(++serial, callback)
      return serial
    }
    scoringClock.cancel = id => {
      timers.delete(id as number)
    }
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        time += ms
        const due = [...timers.values()]
        timers.clear()
        for (const callback of due) callback()
      })
    }
    try {
      const source = new DevelopmentScoringSource()
      await mount(source)
      const outcome = props().ballInPlayControl as React.ReactElement<{
        onChoose: (outcome: string) => void
      }>
      await step(() => {
        outcome.props.onChoose('Single')
      })
      const fielder = players().find(
        player => player.playerId === 10 && player.team !== 'offense'
      )
      await step(() => field().onFieldPlacement?.(placement(fielder?.id ?? '')))
      await step(() =>
        field().onTrajectoryAccepted?.(25, field().interaction?.generation ?? 0)
      )
      await settle()
      const remaining = props().remainingMs
      expect(remaining).to.be.a('number')
      expect(timers.size).greaterThan(0)
      await step(() => props().onHistoryOpen?.())
      const detail = props().historyDetail?.primary
      if (detail != null)
        expect(props().historyRows?.at(-1)?.description).includes(detail)
      expect(timers.size).equals(0)
      await advance(10000)
      expect(props().remainingMs).equals(remaining)
      await step(() => props().onHistoryClose?.())
      expect(timers.size).greaterThan(0)
      await advance(250)
      expect(props().remainingMs).lessThan(remaining!)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const current = source.store.games.get('g1')?.currentPlay
      expect(current).not.equals(null)
      const target = tagTargets(current!)[0]
      await step(() => props().onTagSelect?.(target))
      expect(timers.size).equals(0)
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="New tag"]'
      )!
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, 'quick release')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        document.querySelector<HTMLElement>('[aria-label="Save tag"]')!.click()
      })
      expect(document.querySelector('[aria-label="New tag"]')).equals(null)
      expect(timers.size).greaterThan(0)
      const resumed = props().remainingMs
      await advance(250)
      expect(props().remainingMs).lessThan(resumed!)
      await advance(10000)
      await step(() => {
        props().onPitch?.('ball')
      })
      await step(() => {
        props().onHistoryOpen?.()
      })
      const older = props().historyRows?.find(row => row.completed === true)
      expect(detail).to.be.a('string')
      expect(older?.description).includes(detail!)
      expect(props().historyRows?.at(-1)?.completed).not.equals(true)
      await step(() => {
        props().onHistoryClose?.()
      })
    } finally {
      await act(async () => {
        root?.unmount()
        root = undefined
      })
      Object.assign(scoringClock, original)
    }
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
