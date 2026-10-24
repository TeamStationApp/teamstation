/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, createRef, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Text } from 'react-native'
import { Easing } from 'react-native-reanimated'

import {
  type FrameClock,
  installFrameClock,
  translationOf
} from '../../test/frameClock'
import {
  backGestureHandlers,
  type StackDragControls,
  type StackIntent,
  StackNavigator,
  type StackNavigatorProps
} from './StackNavigator'
import { COVER_MS, PUSH_MS, type StackScene } from './stackScene'

const ease = Easing.bezier(0.2, 0.9, 0.3, 1).factory()
const query = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
const mounts = new Map<string, number>()
const unmounts = new Map<string, number>()

function Screen(props: { name: string }): React.ReactElement {
  useEffect(() => {
    mounts.set(props.name, (mounts.get(props.name) ?? 0) + 1)
    return () => {
      unmounts.set(props.name, (unmounts.get(props.name) ?? 0) + 1)
    }
  }, [props.name])
  return <Text>{props.name}</Text>
}

function scene(
  key: string,
  options: Partial<Omit<StackScene, 'key' | 'node'>> = {}
): StackScene {
  return {
    key,
    group: 'home',
    depth: 1,
    presentation: 'push',
    immersive: false,
    node: <Screen name={key} />,
    ...options
  }
}

let root: Root | undefined
let host: HTMLDivElement
let clock: FrameClock
const intent: { current: StackIntent | undefined } = { current: undefined }
let props: StackNavigatorProps

async function show(
  next: Partial<StackNavigatorProps>,
  said?: StackIntent
): Promise<void> {
  props = { ...props, ...next }
  intent.current = said
  await act(async () => {
    root!.render(<StackNavigator {...props} />)
  })
  intent.current = undefined
}

async function start(top: StackScene, reduced = false): Promise<void> {
  AccessibilityInfo.isReduceMotionEnabled = async () => reduced
  AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  props = {
    top,
    intent,
    headerHeight: 0,
    onHandoff: () => undefined,
    onBackOverride: () => undefined
  }
  await show({})
  // The motion preference settles after its promise.
  await act(async () => {
    await Promise.resolve()
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    clock.advance(ms)
  })
}

function wrapper(key: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-scene="${key}"]`)
}
function offset(key: string): { x: number; y: number } {
  const element = wrapper(key)
  expect(element, key).not.equals(null)
  return translationOf(element!)
}
function sceneKeys(): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-scene]')].map(
    element => element.dataset.scene ?? ''
  )
}
// A phone's window. jsdom lays nothing out, so the size React Native for Web
// reads from the document element is given here.
const WIDTH = 402
const HEIGHT = 874
const width = (): number => WIDTH
const height = (): number => HEIGHT
function sizeWindow(w: number, h: number): void {
  for (const [name, value] of [
    ['clientWidth', w],
    ['clientHeight', h]
  ] as const)
    Object.defineProperty(document.documentElement, name, {
      configurable: true,
      value
    })
  window.dispatchEvent(new window.Event('resize'))
}

/**
 * Where the eased progress is at the last frame run: Reanimated takes the
 * animation's start from the clock when it is set, and the frame's own
 * timestamp after that. A style can trail its value by one frame, so both the
 * last frame and the one before are offered.
 */
function progressAt(begun: number, duration: number): number[] {
  const frames = clock.frames
  return frames
    .slice(-2)
    .map(time => ease(Math.min(1, (time - begun) / duration)))
}
function near(actual: number, candidates: number[]): void {
  expect(
    candidates.some(candidate => Math.abs(actual - candidate) <= 1),
    `${actual} not within 1 px of ${candidates.join(' or ')}`
  ).equals(true)
}

describe('stack navigator', function () {
  beforeEach(() => {
    sizeWindow(WIDTH, HEIGHT)
    clock = installFrameClock()
    mounts.clear()
    unmounts.clear()
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    clock.restore()
    sizeWindow(0, 0)
    AccessibilityInfo.isReduceMotionEnabled = query
    AccessibilityInfo.addEventListener = subscribe
  })

  describe('stack navigator push (U4)', function () {
    it('slides the incoming scene in over the outgoing one, which shifts left', async function () {
      await start(scene('team'))
      await show(
        { top: scene('player', { depth: 2 }) },
        { direction: 'forward' }
      )
      const begun = clock.now()
      expect(sceneKeys().sort()).deep.equals(['player', 'team'])
      const seen: number[] = []
      for (let step = 0; step < 6; step++) {
        await advance(16)
        seen.push(offset('player').x)
      }
      const p = progressAt(begun, PUSH_MS)
      near(
        offset('player').x,
        p.map(value => (1 - value) * width())
      )
      near(
        offset('team').x,
        p.map(value => -0.3 * value * width())
      )
      for (let index = 1; index < seen.length; index++)
        expect(seen[index]).most(seen[index - 1])
      expect(wrapper('player')!.dataset.sceneRole).equals('incoming')
      expect(wrapper('team')!.dataset.sceneRole).equals('outgoing')
      await advance(PUSH_MS)
      expect(sceneKeys()).deep.equals(['player'])
      expect(offset('player').x).equals(0)
      expect(mounts.get('player')).equals(1)
      expect(unmounts.get('team')).equals(1)
    })
  })

  describe('stack navigator back (U5)', function () {
    it('plays the push in reverse and unmounts the popped scene', async function () {
      await start(scene('player', { depth: 2 }))
      await show({ top: scene('team') }, { direction: 'back' })
      const begun = clock.now()
      await advance(96)
      const p = progressAt(begun, PUSH_MS)
      near(
        offset('player').x,
        p.map(value => value * width())
      )
      near(
        offset('team').x,
        p.map(value => -0.3 * (1 - value) * width())
      )
      await advance(PUSH_MS)
      expect(sceneKeys()).deep.equals(['team'])
      expect(unmounts.get('player')).equals(1)
    })
  })

  describe('stack navigator cover (U6)', function () {
    it('covers from the bottom over the chrome and uncovers the same way', async function () {
      await start(scene('game'))
      await show({
        chrome: <Text>Chrome</Text>,
        top: scene('score', {
          presentation: 'cover',
          immersive: true,
          depth: 2
        })
      })
      await show({}, undefined)
      // No intent and deeper in the same tab: forward, as a cover.
      expect(sceneKeys().sort()).deep.equals(['game', 'score'])
      await advance(96)
      const chrome = [...host.querySelectorAll<HTMLElement>('div')].find(
        element =>
          element.textContent === 'Chrome' && element.style.zIndex !== ''
      )
      // Between the cover and the game it covers.
      expect(Number(chrome?.style.zIndex)).equals(3)
      expect(Number(wrapper('score')!.style.zIndex)).equals(4)
      expect(Number(wrapper('game')!.style.zIndex)).equals(2)
      expect(offset('score').y).greaterThan(0)
      expect(offset('score').y).lessThan(height())
      expect(offset('game')).deep.equals({ x: 0, y: 0 })
      await advance(COVER_MS)
      expect(host.textContent).not.includes('Chrome')
      await show({ top: scene('game') }, { direction: 'back' })
      await advance(96)
      expect(offset('score').y).greaterThan(0)
      expect(host.textContent).includes('Chrome')
      await advance(COVER_MS)
      expect(sceneKeys()).deep.equals(['game'])
    })

    it('keeps the retained scene mounted and hidden, and the same instance on top again', async function () {
      const score = scene('score', { presentation: 'cover', immersive: true })
      await start(score, true)
      await show(
        { top: scene('settings', { depth: 2 }), retained: score },
        { direction: 'forward' }
      )
      const kept = wrapper('score')!
      expect(kept.style.display).equals('none')
      expect(kept.getAttribute('aria-hidden')).equals('true')
      expect(host.textContent).includes('settings')
      await show({ top: score, retained: undefined }, { direction: 'back' })
      await show({ top: scene('settings', { depth: 2 }), retained: score })
      await show({ top: score, retained: undefined }, { direction: 'back' })
      expect(mounts.get('score')).equals(1)
      expect(unmounts.get('score') ?? 0).equals(0)
      expect(mounts.get('settings')).equals(2)
    })
  })

  describe('stack navigator reduced motion (U7)', function () {
    it('settles a reduced motion push in the same frame', async function () {
      await start(scene('team'), true)
      await show(
        { top: scene('player', { depth: 2 }) },
        { direction: 'forward' }
      )
      expect(sceneKeys()).deep.equals(['player'])
      expect(offset('player').x).equals(0)
    })

    it('settles a reduced motion cover in the same frame', async function () {
      await start(scene('game'), true)
      await show(
        { top: scene('score', { presentation: 'cover', immersive: true }) },
        { direction: 'forward' }
      )
      expect(sceneKeys()).deep.equals(['score'])
    })
  })

  describe('stack navigator edge drag (U8, U9, U10)', function () {
    it('completes a drag: the beneath scene becomes the top without a second mount', async function () {
      let below = 0
      let popped = 0
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => {
          below++
          return scene('team')
        },
        onSwipeBack: () => {
          popped++
        }
      })
      await act(async () => {
        expect(controls.current!.begin()).equals(true)
      })
      expect(below).equals(1)
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      await act(async () => {
        controls.current!.move(width() * 0.4)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.4])
      near(offset('team').x, [-0.3 * 0.6 * width()])
      await act(async () => {
        controls.current!.release(width() * 0.6, 0)
      })
      expect(popped).equals(0)
      await advance(300)
      expect(popped).equals(1)
      await show(
        { top: scene('team'), onSwipeBack: undefined },
        { direction: 'back' }
      )
      expect(sceneKeys()).deep.equals(['team'])
      expect(offset('team').x).equals(0)
      expect(mounts.get('team')).equals(1)
    })

    it('leaves the pop to a Back that came while the drag ran out', async function () {
      let popped = 0
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => {
          popped++
        }
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.6)
        controls.current!.release(width() * 0.6, 0)
      })
      await advance(100)
      // The header chevron popped the player before the drag ran out.
      await show(
        { top: scene('team'), onSwipeBack: () => (popped += 10) },
        { direction: 'back' }
      )
      await advance(300)
      expect(popped).equals(0)
      expect(sceneKeys()).deep.equals(['team'])
    })

    it('lets a three-button Back during the pan’s drag add nothing', async function () {
      let popped = 0
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => {
          popped++
        }
      })
      const on = backGestureHandlers(controls.current!, {
        enabled: true,
        width,
        dragging: () => wrapper('team') != null,
        pop: () => {
          popped++
          return true
        }
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.6)
        controls.current!.release(width() * 0.6, 0)
      })
      await advance(100)
      await act(async () => {
        expect(on.onInvoke()).equals(true)
      })
      await advance(300)
      expect(popped).equals(1)
    })

    it('shows the retained instance beneath instead of a second one', async function () {
      const controls = createRef<StackDragControls>()
      const score = scene('score', { presentation: 'cover', immersive: true })
      await start(scene('settings', { depth: 2 }))
      await show({
        retained: score,
        dragControls: controls,
        renderBelow: () => score,
        onSwipeBack: () => undefined
      })
      await act(async () => {
        controls.current!.begin()
      })
      expect(wrapper('score')!.dataset.sceneRole).equals('beneath')
      expect(wrapper('score')!.style.display).not.equals('none')
      expect(mounts.get('score')).equals(1)
    })

    it('cancels a short drag without popping', async function () {
      let popped = 0
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => {
          popped++
        }
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(80)
        controls.current!.release(80, 100)
      })
      await advance(300)
      expect(popped).equals(0)
      expect(sceneKeys()).deep.equals(['player'])
      expect(offset('player').x).equals(0)
    })

    it('springs back when the stack has not moved after a completed drag', async function () {
      const controls = createRef<StackDragControls>()
      const realTimeout = setTimeout
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => undefined
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.complete()
      })
      await advance(300)
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 550))
      })
      await advance(300)
      expect(sceneKeys()).deep.equals(['player'])
      expect(offset('player').x).equals(0)
    })

    it('offers no drag without a pop, and none twice at once', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({ dragControls: controls, renderBelow: () => scene('team') })
      await act(async () => {
        expect(controls.current!.begin()).equals(false)
      })
      await show({ onSwipeBack: () => undefined })
      await act(async () => {
        expect(controls.current!.begin()).equals(true)
        expect(controls.current!.begin()).equals(false)
      })
    })
  })

  describe('stack navigator with Android’s back gesture (U20)', function () {
    async function gesture(): Promise<{
      on: ReturnType<typeof backGestureHandlers>
      popped: () => number
      below: () => number
    }> {
      let popped = 0
      let below = 0
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => {
          below++
          return scene('team')
        },
        onSwipeBack: () => {
          popped++
        }
      })
      const on = backGestureHandlers(controls.current!, {
        enabled: true,
        width,
        dragging: () => wrapper('team') != null,
        pop: () => {
          popped++
          return true
        }
      })
      return { on, popped: () => popped, below: () => below }
    }

    it('reveals the screen beneath, follows progress and springs back on cancel', async function () {
      const { on, popped, below } = await gesture()
      await act(async () => {
        on.onStart()
      })
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      await act(async () => {
        on.onProgress(0.4)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.4])
      await act(async () => {
        on.onCancel()
      })
      await advance(300)
      expect(popped()).equals(0)
      expect(sceneKeys()).deep.equals(['player'])
      expect(below()).equals(1)
    })

    it('completes a drag on invoke, and pops a plain press', async function () {
      const { on, popped } = await gesture()
      // Each as its own event, as the phone sends them.
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        on.onProgress(0.6)
      })
      await act(async () => {
        on.onInvoke()
      })
      await advance(300)
      expect(popped()).equals(1)
      await show(
        { top: scene('team'), onSwipeBack: undefined },
        { direction: 'back' }
      )
      expect(sceneKeys()).deep.equals(['team'])
      const again = await gesture()
      await act(async () => {
        again.on.onInvoke()
      })
      expect(again.popped()).equals(1)
    })

    it('pops once for a second Back while a completed drag waits on its pop', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        on.onProgress(0.6)
      })
      await act(async () => {
        on.onInvoke()
      })
      await advance(300)
      expect(popped()).equals(1)
      // The shell has not moved yet (a leave confirm, say): the drag stays,
      // completed, and another Back adds nothing to it.
      await act(async () => {
        expect(on.onInvoke()).equals(true)
      })
      await advance(300)
      expect(popped()).equals(1)
    })

    it('lets a second swipe during the run-out neither move nor undo the first', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        on.onProgress(0.6)
      })
      await act(async () => {
        on.onInvoke()
      })
      await advance(100)
      // A second swipe, straight after: ignored, as is its progress.
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        on.onProgress(0.2)
      })
      await act(async () => {
        on.onCancel()
      })
      await act(async () => {
        on.onInvoke()
      })
      await advance(300)
      expect(popped()).equals(1)
      // The shell pops, and the drag is over.
      await show(
        { top: scene('team'), onSwipeBack: undefined },
        { direction: 'back' }
      )
      expect(sceneKeys()).deep.equals(['team'])
      expect(offset('team').x).equals(0)
    })

    it('is off while there is nothing to pop with', async function () {
      await start(scene('player', { depth: 2 }))
      const gesture = (): string | undefined =>
        host.querySelector<HTMLElement>('[data-predictive-back]')?.dataset
          .predictiveBack
      await show({ predictiveBack: true, onSwipeBack: () => undefined })
      expect(gesture()).equals('true')
      // A back override took Back in this render.
      await show({ predictiveBack: true, onSwipeBack: undefined })
      expect(gesture()).equals('false')
    })

    it('takes over a drag the edge pan began before the gesture started', async function () {
      const { on, popped } = await gesture()
      const controls = props.dragControls as React.RefObject<StackDragControls>
      // The pan activates on the first move, before the system's `started`.
      await act(async () => {
        expect(controls.current.begin()).equals(true)
      })
      await act(async () => {
        controls.current.move(width() * 0.1)
      })
      await act(async () => {
        on.onStart()
      })
      // The system takes the touch: the pan is cancelled, and that no longer
      // ends the drag.
      await act(async () => {
        controls.current.cancel()
      })
      await advance(300)
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      await act(async () => {
        on.onProgress(0.4)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.4])
      // The pan cannot move it any more, nor start a second one.
      await act(async () => {
        controls.current.move(width() * 0.9)
        expect(controls.current.begin()).equals(false)
        expect(controls.current.begin('predictive')).equals(false)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.4])
      await act(async () => {
        on.onInvoke()
      })
      await advance(300)
      expect(popped()).equals(1)
    })

    it('keeps the gesture’s drag when the edge pan the system took is cancelled', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      // Under gesture navigation the system takes the edge touch, and the
      // app's pan finalizes as cancelled: that must not end this drag.
      const controls = props.dragControls as React.RefObject<StackDragControls>
      await act(async () => {
        controls.current.cancel()
        controls.current.release(width(), 0)
      })
      await advance(300)
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      await act(async () => {
        on.onProgress(0.4)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.4])
      expect(popped()).equals(0)
    })

    it('ignores a gesture start during a drag already under way', async function () {
      const { on, below } = await gesture()
      await act(async () => {
        on.onStart()
        on.onStart()
      })
      expect(below()).equals(1)
    })
  })

  describe('stack navigator navigation during motion (U21)', function () {
    it('settles a running push when another starts', async function () {
      await start(scene('a', { depth: 0 }))
      await show({ top: scene('b') }, { direction: 'forward' })
      await advance(96)
      await show({ top: scene('c', { depth: 2 }) }, { direction: 'forward' })
      expect(sceneKeys().sort()).deep.equals(['b', 'c'])
      expect(unmounts.get('a')).equals(1)
      // From rest: one frame in, b has barely begun its shift left.
      await advance(16)
      expect(offset('b').x).within(-0.3 * width(), 0)
      expect(offset('b').x).greaterThan(-0.3 * width() * 0.5)
      expect(offset('c').x).greaterThan(width() * 0.5)
    })

    it('keeps the settling scene as the top when it is the same screen', async function () {
      await start(scene('game#0', { depth: 3 }))
      await show({ top: scene('team', { depth: 2 }) }, { direction: 'back' })
      await advance(48)
      // The lower copy of the same game, keyed alike.
      await show({ top: scene('game#0') }, { direction: 'back' })
      expect(mounts.get('game#0')).equals(1)
      expect(unmounts.get('game#0') ?? 0).equals(0)
    })

    it('cancels a drag without animation when the top changes', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => undefined
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(100)
      })
      await show({ top: scene('home', { depth: 0 }) }, { direction: 'back' })
      expect(sceneKeys().sort()).deep.equals(['home', 'player'])
      expect(wrapper('team')).equals(null)
      await advance(PUSH_MS + 16)
      expect(sceneKeys()).deep.equals(['home'])
    })

    it('settles a cover when the navbar switches tabs', async function () {
      await start(scene('game'))
      await show(
        { top: scene('score', { presentation: 'cover', immersive: true }) },
        { direction: 'forward' }
      )
      await advance(48)
      await show(
        { top: scene('schedule:root', { group: 'schedule', depth: 0 }) },
        { direction: 'none' }
      )
      expect(sceneKeys()).deep.equals(['schedule:root'])
    })
  })
})
