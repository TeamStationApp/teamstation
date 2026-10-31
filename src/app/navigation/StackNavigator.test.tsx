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
import { useHeaderHandoff } from '../components/headerSlot'
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
  // A test that starts a second navigator ends the first: left mounted, its
  // timers (a drag's pop fallback) would fire into whatever test runs next.
  if (root != null) {
    const previous = root
    await act(async () => {
      previous.unmount()
    })
    host.remove()
  }
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

// The scenes on show or moving; the one kept covered beneath the top is
// `covered()`.
const SHOWN = ':not([data-scene-role="covered"])'
function wrapper(key: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-scene="${key}"]${SHOWN}`)
}
function offset(key: string): { x: number; y: number } {
  const element = wrapper(key)
  expect(element, key).not.equals(null)
  return translationOf(element!)
}
function sceneKeys(): string[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-scene]${SHOWN}`)].map(
    element => element.dataset.scene ?? ''
  )
}
function covered(): string[] {
  return [
    ...host.querySelectorAll<HTMLElement>('[data-scene-role="covered"]')
  ].map(element => element.dataset.scene ?? '')
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

    for (const reduced of [false, true])
      it(`mounts a screen pushed again over the frame kept beneath as one of its own, both ways${reduced ? ', under reduced motion' : ''}`, async function () {
        // [game G, team]: G is kept covered beneath the team.
        await start(scene('team', { depth: 2 }), reduced)
        await show({ renderBelow: () => scene('game') })
        expect(covered()).deep.equals(['game'])
        expect(mounts.get('game')).equals(1)
        // G again, from the team's schedule: a new screen, not the hidden one.
        await show(
          {
            top: scene('game', { depth: 3 }),
            renderBelow: () => scene('team', { depth: 2 })
          },
          { direction: 'forward' }
        )
        await advance(PUSH_MS + 32)
        expect(mounts.get('game')).equals(2)
        expect(unmounts.get('game')).equals(1)
        // Back: the G kept beneath the team again is the first frame's, not the
        // screen that just left.
        await show(
          {
            top: scene('team', { depth: 2 }),
            renderBelow: () => scene('game')
          },
          { direction: 'back' }
        )
        await advance(PUSH_MS + 32)
        expect(covered()).deep.equals(['game'])
        expect(mounts.get('game')).equals(3)
        expect(unmounts.get('game')).equals(2)
      })

    it('keeps the screen when a pop is turned back by pushing it again', async function () {
      // On B over A, Back, then B again (a browser Forward, or B tapped on A)
      // before the pop ends: the same B comes back from where it stands.
      await start(scene('b', { depth: 2 }))
      await show(
        { top: scene('a'), renderBelow: () => undefined },
        { direction: 'back' }
      )
      await advance(100)
      const leaving = offset('b').x
      await show(
        { top: scene('b', { depth: 2 }), renderBelow: () => scene('a') },
        { direction: 'forward' }
      )
      await advance(16)
      expect(mounts.get('b')).equals(1)
      expect(unmounts.get('b') ?? 0).equals(0)
      expect(offset('b').x).closeTo(leaving, width() / 10)
      await advance(PUSH_MS + 64)
      expect(sceneKeys()).deep.equals(['b'])
      expect(mounts.get('b')).equals(1)
    })

    it('mounts a screen pushed again while it still slides out as one of its own', async function () {
      // On game G, open team T, and tap G on T's schedule before the push ends.
      await start(scene('game'))
      await show(
        { top: scene('team', { depth: 2 }), renderBelow: () => scene('game') },
        { direction: 'forward' }
      )
      await advance(100)
      expect(mounts.get('game')).equals(1)
      await show(
        {
          top: scene('game', { depth: 3 }),
          renderBelow: () => scene('team', { depth: 2 })
        },
        { direction: 'forward' }
      )
      await advance(PUSH_MS + 32)
      expect(mounts.get('game')).equals(2)
      expect(unmounts.get('game')).equals(1)
    })

    it('keeps the covered screen’s header while a screen that draws none is pushed over it', async function () {
      // A game whose score has scrolled up into the header, and Replay, which
      // draws no header, pushed over it as a push rather than a cover.
      function Game(): React.ReactElement {
        useHeaderHandoff('Score 3–2')
        return <Text>game</Text>
      }
      const handed: React.ReactNode[] = []
      await start({ ...scene('game'), node: <Game /> })
      await show({
        onHandoff: node => {
          handed.push(node)
        }
      })
      await show({ top: scene('game', { depth: 1 }) })
      const game = { ...scene('game'), node: <Game /> }
      await show({ top: game })
      expect(handed.at(-1)).equals('Score 3–2')
      await show(
        {
          top: scene('replay', { depth: 2, immersive: true }),
          renderBelow: () => game
        },
        { direction: 'forward' }
      )
      await advance(100)
      // Under the replay as it slides in, the header is still the game's.
      expect(handed.at(-1)).equals('Score 3–2')
      await advance(PUSH_MS + 32)
      expect(handed.at(-1)).equals(null)
    })

    it('keeps the leaving screen’s header while it pops back onto a screen that draws none', async function () {
      // A player's settings, its name pinned up into the header, popped
      // back onto the scorer.
      function Settings(): React.ReactElement {
        useHeaderHandoff('Alex Lee')
        return <Text>settings</Text>
      }
      const handed: React.ReactNode[] = []
      const score = scene('score', { immersive: true, presentation: 'cover' })
      await start({ ...scene('settings', { depth: 2 }), node: <Settings /> })
      await show({
        onHandoff: node => {
          handed.push(node)
        },
        renderBelow: () => score
      })
      // Drawn again under the recording handler.
      await show({ top: scene('settings', { depth: 2 }) })
      await show({
        top: { ...scene('settings', { depth: 2 }), node: <Settings /> }
      })
      expect(handed.at(-1)).equals('Alex Lee')
      await show(
        { top: score, renderBelow: () => undefined },
        { direction: 'back' }
      )
      await advance(100)
      // Sliding off with the header riding on it, still its own.
      expect(handed.at(-1)).equals('Alex Lee')
      await advance(PUSH_MS + 32)
      expect(handed.at(-1)).equals(null)
    })

    it('keeps a completed drag run out while its pop is still being decided', async function () {
      let pending = true
      let popped = 0
      const controls = createRef<StackDragControls>()
      const realTimeout = setTimeout
      await start(scene('schedule', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('home'),
        // A leave check saving an open note: the pop waits on it.
        onSwipeBack: () => {
          popped++
        },
        popPending: () => pending
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.6)
        controls.current!.release(width() * 0.6, 0)
      })
      await advance(300)
      expect(popped).equals(1)
      // Past the fallback: still run out, not sprung back.
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 650))
      })
      await advance(300)
      expect(offset('schedule').x).closeTo(width(), 2)
      // The check accepts: the pop lands, with no second run off.
      pending = false
      await show({ top: scene('home') }, { direction: 'back' })
      await advance(32)
      expect(sceneKeys()).deep.equals(['home'])
      expect(popped).equals(1)
    })

    it('asks a pending pop again often, and springs back once it is refused', async function () {
      let pending = true
      let asked = 0
      const controls = createRef<StackDragControls>()
      const realTimeout = setTimeout
      await start(scene('schedule', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('home'),
        onSwipeBack: () => undefined,
        popPending: () => {
          asked++
          return pending
        }
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.6)
        controls.current!.release(width() * 0.6, 0)
      })
      await advance(300)
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 1200))
      })
      // Asked every tenth of a second or so, not every half second: a
      // refusal is answered as soon as it comes.
      expect(asked).greaterThan(3)
      expect(offset('schedule').x).closeTo(width(), 2)
      // The save fails: the check refuses, and the top comes back.
      pending = false
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 400))
      })
      await advance(300)
      expect(offset('schedule').x).equals(0)
    })

    it('springs a drag back, usable, when its pop stays undecided past the cap', async function () {
      this.timeout(15000)
      let popped = 0
      const controls = createRef<StackDragControls>()
      const realTimeout = setTimeout
      await start(scene('schedule', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('home'),
        onSwipeBack: () => {
          popped++
        },
        // A note save over a stalled network: never answers.
        popPending: () => true
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.6)
        controls.current!.release(width() * 0.6, 0)
      })
      await advance(300)
      expect(popped).equals(1)
      // Within the cap: still run out.
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 1200))
      })
      await advance(300)
      expect(offset('schedule').x).closeTo(width(), 2)
      // Past it: back on screen, the drag over, and a new one may begin.
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 2600))
      })
      await advance(300)
      expect(offset('schedule').x).equals(0)
      expect(wrapper('home')).equals(null)
      await act(async () => {
        expect(controls.current!.begin()).equals(true)
        controls.current!.cancel()
      })
      await advance(300)
      // The save answers at last: the pop lands as an ordinary back slide.
      await show({ top: scene('home') }, { direction: 'back' })
      await advance(32)
      expect(sceneKeys().sort()).deep.equals(['home', 'schedule'])
      await advance(PUSH_MS + 32)
      expect(sceneKeys()).deep.equals(['home'])
    })

    it('keeps the scene beneath mounted and hidden, and pops back to it as it stood', async function () {
      await start(scene('team'))
      await show(
        {
          top: scene('player', { depth: 2 }),
          renderBelow: () => scene('team')
        },
        { direction: 'forward' }
      )
      await advance(PUSH_MS + 32)
      // Covered: mounted once, hidden from sight, touch and the reader.
      expect(sceneKeys()).deep.equals(['player'])
      expect(covered()).deep.equals(['team'])
      const kept = host.querySelector<HTMLElement>('[data-scene="team"]')!
      // Hidden, still laid out: a browser keeps its scrollers' places.
      expect(kept.style.visibility).equals('hidden')
      expect(kept.style.display).not.equals('none')
      expect(kept.getAttribute('aria-hidden')).equals('true')
      await show(
        { top: scene('team'), renderBelow: () => undefined },
        { direction: 'back' }
      )
      await advance(PUSH_MS + 32)
      expect(sceneKeys()).deep.equals(['team'])
      expect(mounts.get('team')).equals(1)
      expect(unmounts.get('team') ?? 0).equals(0)
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

    it('lets touches through the chrome layer to the scenes beneath', async function () {
      await start(scene('team'))
      await show({ chrome: <Text>Chrome</Text> })
      const chrome = host.querySelector<HTMLElement>('[data-chrome="true"]')!
      // The layer spans the window; only what is drawn in it takes touches.
      expect(window.getComputedStyle(chrome).pointerEvents).equals('none')
    })

    it('slides the chrome with a scene pushed over, or popped back to, the scorer', async function () {
      await start(
        scene('score', { presentation: 'cover', immersive: true, depth: 2 })
      )
      await show(
        {
          chrome: <Text>Chrome</Text>,
          top: scene('settings', { depth: 3 })
        },
        { direction: 'forward' }
      )
      const chrome = (): HTMLElement =>
        host.querySelector<HTMLElement>('[data-chrome="true"]')!
      await advance(96)
      // The header and navbar are the settings screen's: they come in with
      // it, not over the scorer from the first frame.
      const settings = offset('settings').x
      expect(settings).greaterThan(0)
      expect(chrome().dataset.chromeRides).equals('true')
      expect(translationOf(chrome()).x).closeTo(settings, 1)
      await advance(PUSH_MS)
      expect(translationOf(chrome()).x).equals(0)
      await show(
        {
          top: scene('score', {
            presentation: 'cover',
            immersive: true,
            depth: 2
          })
        },
        { direction: 'back' }
      )
      await advance(96)
      expect(translationOf(chrome()).x).closeTo(offset('settings').x, 1)
      expect(translationOf(chrome()).x).greaterThan(0)
    })

    it('keeps the retained scene mounted and hidden, and the same instance on top again', async function () {
      const score = scene('score', { presentation: 'cover', immersive: true })
      await start(score, true)
      await show(
        { top: scene('settings', { depth: 2 }), retained: score },
        { direction: 'forward' }
      )
      const kept = wrapper('score')!
      expect(kept.style.visibility).equals('hidden')
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
        expect(controls.current!.begin()).equals(true)
      })
      // One drag: the screen beneath is mounted once, however often it is drawn.
      expect(mounts.get('team')).equals(1)
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
      // Popped as it is let go, not once it has run out.
      expect(popped).equals(1)
      await show(
        { top: scene('team'), onSwipeBack: undefined },
        { direction: 'back' }
      )
      await advance(PUSH_MS + 32)
      expect(sceneKeys()).deep.equals(['team'])
      expect(offset('team').x).equals(0)
      expect(mounts.get('team')).equals(1)
    })

    it('pops as a drag is let go, and goes on from where the run out has the top', async function () {
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
      expect(popped).equals(1)
      await advance(64)
      const running = offset('player').x
      expect(running).greaterThan(width() * 0.6)
      expect(running).lessThan(width())
      // The shell's pop lands a few frames later: the move goes on from there,
      // with no pause, no jump back and none to the end.
      await show(
        { top: scene('team'), onSwipeBack: undefined },
        { direction: 'back' }
      )
      await advance(16)
      expect(sceneKeys().sort()).deep.equals(['player', 'team'])
      expect(offset('player').x).greaterThan(running)
      expect(offset('player').x).lessThan(width())
      await advance(PUSH_MS + 32)
      expect(sceneKeys()).deep.equals(['team'])
      expect(offset('team').x).equals(0)
      expect(popped).equals(1)
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
      expect(wrapper('score')!.style.visibility).not.equals('hidden')
      expect(mounts.get('score')).equals(1)
    })

    it('draws the screen beneath as the shell has it now while a drag is held', async function () {
      const controls = createRef<StackDragControls>()
      let label = 'team'
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => ({ ...scene('team'), node: <Text>{label}</Text> }),
        onSwipeBack: () => undefined
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.3)
      })
      expect(wrapper('team')!.textContent).equals('team')
      // The shell changes beneath the held drag: it shows.
      label = 'team, updated'
      await show({})
      expect(wrapper('team')!.textContent).equals('team, updated')
    })

    it('ends with no drag held when a second swipe comes while the first springs back', async function () {
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
      for (let swipe = 0; swipe < 2; swipe++) {
        await act(async () => {
          controls.current!.begin()
          controls.current!.move(80)
          controls.current!.release(80, 100)
        })
        await advance(100)
      }
      await advance(300)
      expect(popped).equals(0)
      expect(sceneKeys()).deep.equals(['player'])
      expect(offset('player').x).equals(0)
      // Not stuck: a drag can begin again.
      await act(async () => {
        expect(controls.current!.begin()).equals(true)
      })
    })

    it('keeps a new drag when one dropped as the top changed finishes springing back', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => undefined
      })
      // Let go short: it springs back.
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(80)
        controls.current!.release(80, 100)
      })
      await advance(50)
      // A link replaces the top while it springs; a new drag begins on it.
      await show({
        top: scene('game', { depth: 2 }),
        renderBelow: () => scene('team')
      })
      await act(async () => {
        expect(controls.current!.begin()).equals(true)
        controls.current!.move(width() * 0.4)
      })
      // The old spring finishes: the new drag is still held.
      await advance(300)
      await act(async () => {
        controls.current!.move(width() * 0.5)
      })
      await advance(16)
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      near(offset('game').x, [width() * 0.5])
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

    it('plays a late pop as a move from where the fallback’s spring stands', async function () {
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
      // The pop is late: the fallback springs the top back in…
      await act(async () => {
        await new Promise(resolve => realTimeout(resolve, 550))
      })
      await advance(64)
      const player = offset('player').x
      expect(player).greaterThan(0)
      expect(player).lessThan(width())
      // …and then it lands: a back move from where the spring has the top,
      // not the top gone at once.
      await show({ top: scene('team') }, { direction: 'back' })
      await advance(16)
      expect(sceneKeys().sort()).deep.equals(['player', 'team'])
      expect(offset('player').x).closeTo(player, width() / 10)
      await advance(PUSH_MS + 64)
      expect(sceneKeys()).deep.equals(['team'])
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
    async function gesture(enabled = true): Promise<{
      on: ReturnType<typeof backGestureHandlers>
      popped: () => number
    }> {
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
        enabled,
        width,
        dragging: () => wrapper('team') != null,
        pop: () => {
          popped++
          return true
        }
      })
      return { on, popped: () => popped }
    }

    it('takes nothing while off, and hands the press on', async function () {
      const { on, popped } = await gesture(false)
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        on.onProgress(0.5)
      })
      expect(wrapper('team')).equals(null)
      await act(async () => {
        expect(on.onInvoke()).equals(false)
      })
      await advance(300)
      expect(popped()).equals(0)
      expect(covered()).deep.equals(['team'])
      expect(sceneKeys()).deep.equals(['player'])
    })

    it('lets go of a drag it began before turning off', async function () {
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
      const options = {
        width,
        dragging: () => wrapper('team') != null,
        pop: () => {
          popped++
          return true
        }
      }
      const on = backGestureHandlers(controls.current!, {
        ...options,
        enabled: true
      })
      await act(async () => {
        on.onStart()
        on.onProgress(0.5)
      })
      expect(wrapper('team')!.dataset.sceneRole).equals('beneath')
      const off = backGestureHandlers(controls.current!, {
        ...options,
        enabled: false
      })
      await act(async () => {
        expect(off.onInvoke()).equals(false)
      })
      await advance(300)
      expect(popped).equals(0)
      expect(sceneKeys()).deep.equals(['player'])
    })

    it('reveals the screen beneath, follows progress and springs back on cancel', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      // Not yet: a Back key also starts, and then sends no progress.
      expect(wrapper('team')).equals(null)
      await act(async () => {
        on.onProgress(0)
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
      // One drag: the screen beneath is mounted once, however often it is drawn.
      expect(mounts.get('team')).equals(1)
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
      await advance(PUSH_MS + 32)
      expect(sceneKeys()).deep.equals(['team'])
      const again = await gesture()
      await act(async () => {
        again.on.onInvoke()
      })
      expect(again.popped()).equals(1)
    })

    it('pops a swipe from the right edge when it is let go, with no drag', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      // The finger moves left: the top would slide right, away from it.
      await act(async () => {
        on.onProgress(0.4, 'right')
      })
      expect(wrapper('team')).equals(null)
      near(offset('player').x, [0])
      await act(async () => {
        expect(on.onInvoke()).equals(true)
      })
      expect(popped()).equals(1)
    })

    it('pops a preview with no edge (three-button Back) when it is let go, with no drag', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
        on.onProgress(0.3, 'none')
      })
      expect(wrapper('team')).equals(null)
      await act(async () => {
        expect(on.onInvoke()).equals(true)
      })
      expect(popped()).equals(1)
    })

    it('takes nothing when the shell says, as the gesture comes, that Back no longer pops', async function () {
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
      // Enabled a render ago; a pill change since makes Back a history step.
      const on = backGestureHandlers(controls.current!, {
        enabled: true,
        width,
        dragging: () => wrapper('team') != null,
        pop: () => {
          popped++
          return true
        },
        allows: () => false
      })
      await act(async () => {
        on.onStart()
        on.onProgress(0.4, 'left')
      })
      expect(wrapper('team')).equals(null)
      await act(async () => {
        // Handed on to `BackHandler`, which walks the history.
        expect(on.onInvoke()).equals(false)
      })
      expect(popped).equals(0)
    })

    it('pops a Back key, which starts and sends no progress, as the chevron does', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
      })
      await act(async () => {
        expect(on.onInvoke()).equals(true)
      })
      // Popped at once, with no drag drawn first: the shell's pop then plays
      // the ordinary back move, or none under reduced motion.
      expect(popped()).equals(1)
      expect(wrapper('team')).equals(null)
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
      await advance(PUSH_MS + 32)
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
      // The gesture's progress adds to where the pan had the top: no snap
      // back to rest as the system claims the touch.
      await act(async () => {
        on.onProgress(0)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.1])
      await act(async () => {
        on.onProgress(0.4)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.5])
      // The pan cannot move it any more, nor start a second one.
      await act(async () => {
        controls.current.move(width() * 0.9)
        expect(controls.current.begin()).equals(false)
        expect(controls.current.begin('predictive')).equals(false)
      })
      await advance(16)
      near(offset('player').x, [width() * 0.5])
      await act(async () => {
        on.onInvoke()
      })
      await advance(300)
      expect(popped()).equals(1)
    })

    it('takes over a pan the system cancelled first, and springs back when the gesture is cancelled', async function () {
      const { on } = await gesture()
      const controls = props.dragControls as React.RefObject<StackDragControls>
      await act(async () => {
        expect(controls.current.begin()).equals(true)
        controls.current.move(width() * 0.1)
      })
      // The system's cancel of the pan before its own start: a spring back
      // has begun.
      await act(async () => {
        controls.current.cancel()
      })
      await advance(32)
      const springing = offset('player').x
      await act(async () => {
        on.onStart()
        on.onProgress(0.4)
      })
      await advance(16)
      // From where the spring had it, by the gesture's progress.
      near(offset('player').x, [springing + width() * 0.4])
      // The gesture is cancelled: the top springs back and the drag ends.
      await act(async () => {
        on.onCancel()
      })
      await advance(300)
      expect(offset('player').x).equals(0)
      expect(wrapper('team')).equals(null)
    })

    it('keeps the gesture’s drag when the edge pan the system took is cancelled', async function () {
      const { on, popped } = await gesture()
      await act(async () => {
        on.onStart()
        on.onProgress(0)
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
      const { on } = await gesture()
      await act(async () => {
        on.onStart()
        on.onStart()
      })
      // One drag: the screen beneath is mounted once, however often it is drawn.
      expect(mounts.get('team')).equals(1)
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

    it('turns a push back from where it stands when Back comes mid-push', async function () {
      await start(scene('team'))
      await show(
        { top: scene('player', { depth: 2 }) },
        { direction: 'forward' }
      )
      await advance(96)
      const player = offset('player').x
      const team = offset('team').x
      expect(player).within(0, width())
      await show({ top: scene('team') }, { direction: 'back' })
      // Where the two scenes stand, not the player fully in and the team
      // shifted all the way left.
      await advance(16)
      expect(offset('player').x).closeTo(player, width() / 10)
      expect(offset('team').x).closeTo(team, width() / 10)
      await advance(80)
      expect(offset('player').x).greaterThan(player)
      // In the rest of the time, not a whole push's.
      await advance(PUSH_MS - 96)
      expect(sceneKeys()).deep.equals(['team'])
    })

    it('takes the top from where a running push has it when a drag begins', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('team'))
      await show(
        {
          top: scene('player', { depth: 2 }),
          dragControls: controls,
          renderBelow: () => scene('team'),
          onSwipeBack: () => undefined
        },
        { direction: 'forward' }
      )
      await advance(96)
      const player = offset('player').x
      const team = offset('team').x
      expect(player).greaterThan(0)
      await act(async () => {
        controls.current!.begin()
      })
      await advance(16)
      // Not the player snapped fully in and the team all the way left.
      expect(offset('player').x).closeTo(player, 1)
      expect(offset('team').x).closeTo(team, 1)
      // The finger moves it on from there.
      await act(async () => {
        controls.current!.move(width() * 0.1)
      })
      await advance(16)
      expect(offset('player').x).closeTo(player + width() * 0.1, 1)
    })

    it('decides a drag begun mid-push on where the top stands', async function () {
      const controls = createRef<StackDragControls>()
      let popped = 0
      await start(scene('team'))
      await show(
        {
          top: scene('player', { depth: 2 }),
          dragControls: controls,
          renderBelow: () => scene('team'),
          onSwipeBack: () => {
            popped++
          }
        },
        { direction: 'forward' }
      )
      await advance(32)
      const base = 1 - offset('player').x / width()
      expect(base).greaterThan(0)
      expect(base).lessThan(0.5)
      // Dragged slowly to the edge, a shorter way than half the width.
      const dx = base * width()
      expect(dx).lessThan(width() / 2)
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(dx)
        controls.current!.release(dx, 0)
      })
      // The run-out (250 ms), then its pop.
      await advance(300)
      expect(popped).equals(1)
    })

    it('takes no drag while a pop is still taking the top off', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('home', { depth: 0 }),
        onSwipeBack: () => undefined
      })
      await show({ top: scene('team') }, { direction: 'back' })
      await advance(96)
      const player = offset('player').x
      let began = true
      await act(async () => {
        began = controls.current!.begin()
      })
      expect(began).equals(false)
      await advance(16)
      // The pop runs on: the player still leaving, nothing beneath revealed.
      expect(offset('player').x).greaterThan(player)
      expect(wrapper('home')).equals(null)
    })

    it('pops from where a drag springing back let go of the top', async function () {
      const controls = createRef<StackDragControls>()
      await start(scene('player', { depth: 2 }))
      await show({
        dragControls: controls,
        renderBelow: () => scene('team'),
        onSwipeBack: () => undefined
      })
      await act(async () => {
        controls.current!.begin()
        controls.current!.move(width() * 0.2)
        controls.current!.release(width() * 0.2, 0)
      })
      await advance(32)
      const player = offset('player').x
      expect(player).greaterThan(0)
      await show({ top: scene('team') }, { direction: 'back' })
      await advance(16)
      expect(offset('player').x).closeTo(player, width() / 10)
      // The rest of a pop, after the moment's hold at the turn.
      await advance(PUSH_MS + 64)
      expect(sceneKeys()).deep.equals(['team'])
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
