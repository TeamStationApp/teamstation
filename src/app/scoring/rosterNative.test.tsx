import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  type GestureResponderEvent,
  Text,
  View,
  type ViewProps
} from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import {
  rosterAccessibilityAction,
  RosterDrag,
  RosterGrip,
  rosterItemLayout,
  rosterResponder
} from './RosterDrag.native'
import { measureRosterView, RosterContext } from './RosterDragContext'
import { RosterGesture } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'
import { RosterRemoveButton } from './RosterRemoveButton'
import { rosterSegmentAt } from './RosterSelector'

const event = (x: number, y: number): GestureResponderEvent =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({ nativeEvent: { pageX: x, pageY: y } }) as GestureResponderEvent
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}
let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})
describe('native roster responder', function () {
  it('activates a tap-only defensive target and yields to a scrolling movement', function () {
    const engine = new RosterGesture(() => undefined)
    let taps = 0
    const handlers = rosterResponder(engine, {
      children: null,
      targetId: 'defense-P',
      onTap: () => {
        taps++
      }
    })
    try {
      handlers.onTouchStart!(event(10, 10))
      handlers.onTouchEnd!(event(10, 10))
      expect(taps).equals(1)
      expect(engine.active).equals(null)
      handlers.onTouchStart!(event(10, 10))
      handlers.onTouchMove!(event(10, 50))
      handlers.onTouchEnd!(event(10, 50))
      expect(taps).equals(1)
      expect(engine.active).equals(null)
    } finally {
      handlers.dispose()
    }
  })
  it('renders an accessible tap action for assigned defensive cards', async function () {
    const engine = new RosterGesture(() => undefined)
    let activated = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterContext.Provider value={engine}>
            <RosterDrag
              targetId="defense-P"
              label="Clear P"
              value="#7 Alex Demo"
              onTap={() => {
                activated++
              }}
            >
              <Text>Player</Text>
            </RosterDrag>
          </RosterContext.Provider>
        </ThemeProvider>
      )
    })
    const node = host.querySelector('[aria-label="Clear P"]')!
    const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'))!
    interface Fiber {
      memoizedProps: ViewProps
      return: Fiber | null
    }
    // Inspect the rendered native View props before the web test adapter filters them.
    let fiber = Reflect.get(node, key) as Fiber | null
    while (fiber != null && fiber.memoizedProps.accessibilityActions == null)
      fiber = fiber.return
    expect(fiber).not.equals(null)
    const props = fiber!.memoizedProps
    expect(props.accessible).equals(true)
    expect(props.accessibilityActions).deep.equals([
      { name: 'activate', label: 'Clear P' }
    ])
    expect(props.accessibilityValue).deep.equals({ text: '#7 Alex Demo' })
    await act(async () => {
      props.onAccessibilityTap?.()
    })
    expect(activated).equals(1)
    const activation = { nativeEvent: { actionName: 'activate' } }
    const handler = props.onAccessibilityAction!
    await act(async () => {
      handler(activation as Parameters<typeof handler>[0])
    })
    expect(activated).equals(2)
  })
  it('keeps reorder containers ungrouped so their nested Remove remains accessible', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const engine = new RosterGesture(() => undefined)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterContext.Provider value={engine}>
            <RosterDrag
              playerId={1}
              label="Reorder Alex Demo"
              onReorder={() => undefined}
            >
              <Text>Alex Demo</Text>
              <RosterRemoveButton
                label="Remove Alex Demo"
                onPress={() => undefined}
              />
            </RosterDrag>
          </RosterContext.Provider>
        </ThemeProvider>
      )
    })
    const node = host.querySelector('[aria-label="Reorder Alex Demo"]')!
    interface Fiber {
      memoizedProps: ViewProps
      return: Fiber | null
    }
    const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'))!
    let fiber = Reflect.get(node, key) as Fiber | null
    while (fiber != null && fiber.memoizedProps.accessibilityActions == null)
      fiber = fiber.return
    expect(fiber!.memoizedProps.accessible).equals(undefined)
    expect(
      fiber!.memoizedProps.accessibilityActions?.map(action => action.name)
    ).deep.equals(['increment', 'decrement'])
    expect(
      host.querySelector('[aria-label="Remove Alex Demo"][role="button"]')
    ).not.equals(null)
  })
  it('drags an assigned defensive card at 10 px with no hold and clears it on a shorter touch, while a lineup card still holds (U33)', async function () {
    const drops: number[] = []
    let taps = 0
    const engine = new RosterGesture(() => undefined)
    engine.targets.set('defense-SS', {
      measure: async () => ({ x: 200, y: 300, width: 100, height: 50 }),
      drop: id => drops.push(id)
    })
    const card = rosterResponder(engine, {
      children: null,
      playerId: 6,
      targetId: 'defense-3B',
      label: 'Clear 3B',
      immediate: true,
      onTap: () => {
        taps++
      }
    })
    const lineup = rosterResponder(engine, {
      children: null,
      playerId: 7,
      label: 'Reorder Seven'
    })
    try {
      card.onTouchStart!(event(10, 10))
      card.onTouchMove!(event(19, 10))
      card.onTouchEnd!(event(19, 10))
      expect(taps).equals(1)
      expect(engine.active).equals(null)
      card.onTouchStart!(event(10, 10))
      expect(card.onMoveShouldSetResponder!(event(20, 10))).equals(true)
      expect(engine.active?.id).equals(6)
      card.onResponderGrant!(event(20, 10))
      card.onResponderMove!(event(230, 320))
      await flush()
      card.onResponderRelease!(event(230, 320))
      await flush()
      expect(drops).deep.equals([6])
      expect(taps).equals(1)
      lineup.onTouchStart!(event(10, 10))
      expect(lineup.onMoveShouldSetResponder!(event(20, 10))).equals(false)
      expect(engine.active).equals(null)
    } finally {
      card.dispose()
      lineup.dispose()
    }
  })
  it('appends on a tap, yields until a half-second hold, drops by native window coordinates and never taps after a drag', async function () {
    const drops: number[] = []
    let taps = 0
    const engine = new RosterGesture(() => undefined)
    engine.targets.set('P', {
      measure: async () => ({ x: 200, y: 300, width: 100, height: 50 }),
      drop: id => drops.push(id)
    })
    const handlers = rosterResponder(engine, {
      children: null,
      playerId: 7,
      label: 'Seven',
      onTap: () => {
        taps++
      }
    })
    expect(handlers.onStartShouldSetResponder!(event(10, 10))).equals(false)
    expect(handlers.onResponderTerminationRequest!(event(10, 10))).equals(true)
    handlers.onTouchStart!(event(10, 10))
    handlers.onTouchEnd!(event(10, 10))
    await flush()
    expect(taps).equals(1)
    handlers.onTouchStart!(event(10, 10))
    await new Promise(resolve => setTimeout(resolve, 510))
    expect(handlers.onMoveShouldSetResponder!(event(10, 10))).equals(true)
    expect(handlers.onResponderTerminationRequest!(event(10, 10))).equals(false)
    handlers.onResponderGrant!(event(10, 10))
    handlers.onResponderMove!(event(230, 320))
    await flush()
    expect(engine.active?.moved).equals(true)
    handlers.onResponderRelease!(event(230, 320))
    await flush()
    expect(drops).deep.equals([7])
    expect(taps).equals(1)
    handlers.onTouchStart!(event(10, 10))
    await new Promise(resolve => setTimeout(resolve, 510))
    expect(handlers.onMoveShouldSetResponder!(event(10, 10))).equals(true)
    expect(handlers.onResponderTerminationRequest!(event(10, 10))).equals(false)
    handlers.onResponderGrant!(event(10, 10))
    handlers.onResponderMove!(event(230, 320))
    handlers.onResponderTerminate!(event(230, 320))
    handlers.onResponderRelease!(event(230, 320))
    await flush()
    expect(taps).equals(1)
    expect(drops).deep.equals([7])
    expect(
      rosterResponder(engine, { children: null, playerId: 7, disabled: true })
        .onStartShouldSetResponder!(event(1, 1))
    ).equals(false)
    expect(
      rosterResponder(engine, { children: null }).onStartShouldSetResponder!(
        event(1, 1)
      )
    ).equals(false)
  })
  it('locks every roster list when the hold fires, before any move or grant, and unlocks when the hold ends', async function () {
    const engine = new RosterGesture(() => undefined)
    const held: boolean[] = []
    engine.heldListeners.add(value => held.push(value))
    const handlers = rosterResponder(engine, {
      children: null,
      playerId: 7,
      label: 'Seven'
    })
    const hold = async (): Promise<void> => {
      held.length = 0
      handlers.onTouchStart!(event(10, 10))
      await new Promise(resolve => setTimeout(resolve, 510))
      expect(engine.active?.id).equals(7)
      expect(held.at(-1)).equals(true)
    }
    await hold()
    handlers.onTouchEnd!(event(10, 10))
    await flush()
    expect(held.at(-1)).equals(false)
    expect(engine.active).equals(null)
    await hold()
    handlers.onTouchCancel!(event(10, 10))
    expect(held.at(-1)).equals(false)
    expect(engine.active).equals(null)
    await hold()
    const before = held.length
    handlers.onResponderGrant!(event(10, 10))
    expect(held.length).equals(before)
    handlers.onResponderTerminate!(event(10, 10))
    expect(held.at(-1)).equals(false)
    expect(engine.active).equals(null)
  })
  it('never locks for a touch that scrolls before the hold or for a quick tap', async function () {
    const engine = new RosterGesture(() => undefined)
    const held: boolean[] = []
    engine.heldListeners.add(value => held.push(value))
    let taps = 0
    const handlers = rosterResponder(engine, {
      children: null,
      playerId: 7,
      label: 'Seven',
      onTap: () => {
        taps++
      }
    })
    handlers.onTouchStart!(event(10, 10))
    handlers.onTouchMove!(event(10, 30))
    await new Promise(resolve => setTimeout(resolve, 510))
    expect(handlers.onMoveShouldSetResponder!(event(10, 40))).equals(false)
    handlers.onTouchEnd!(event(10, 40))
    handlers.onTouchStart!(event(10, 10))
    handlers.onTouchEnd!(event(10, 10))
    await flush()
    expect(held).not.includes(true)
    expect(engine.active).equals(null)
    expect(taps).equals(1)
  })
  it('picks a card up as a touch lands on its grip, holds half a second on its body, and lets a body move before then scroll (N2)', async function () {
    const engine = new RosterGesture(() => undefined)
    const held: boolean[] = []
    engine.heldListeners.add(value => held.push(value))
    const handlers = rosterResponder(engine, {
      children: null,
      playerId: 7,
      label: 'Seven'
    })
    try {
      // The grip: the card lifts and every list locks as the touch lands.
      handlers.grip()
      handlers.onTouchStart!(event(4, 10))
      expect(engine.active?.id).equals(7)
      expect(held.at(-1)).equals(true)
      // The grip holds the touch; the card follows it by its touch events,
      // never asking for it, as a grant would stop them reaching it.
      expect(handlers.onMoveShouldSetResponder!(event(4, 12))).equals(false)
      handlers.onTouchMove!(event(4, 40))
      await flush()
      expect(engine.active?.moved).equals(true)
      handlers.onTouchEnd!(event(4, 40))
      await flush()
      expect(engine.active).equals(null)
      // The body, on the next touch: the grip's mark is spent.
      held.length = 0
      handlers.onTouchStart!(event(90, 10))
      expect(engine.active).equals(null)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(engine.active).equals(null)
      await new Promise(resolve => setTimeout(resolve, 210))
      expect(engine.active?.id).equals(7)
      handlers.onTouchEnd!(event(90, 10))
      await flush()
      // A body move before the hold fires scrolls, and nothing lifts.
      held.length = 0
      handlers.onTouchStart!(event(90, 10))
      handlers.onTouchMove!(event(90, 40))
      await new Promise(resolve => setTimeout(resolve, 510))
      expect(handlers.onMoveShouldSetResponder!(event(90, 60))).equals(false)
      handlers.onTouchEnd!(event(90, 60))
      expect(held).not.includes(true)
      expect(engine.active).equals(null)
      // A grip touch that goes nowhere is the card's tap: its drag is put
      // back, and the tap runs, as on an Add to Lineup card.
      const taps: number[] = []
      const tapped = rosterResponder(engine, {
        children: null,
        playerId: 9,
        label: 'Nine',
        onTap: () => taps.push(9)
      })
      tapped.grip()
      tapped.onTouchStart!(event(4, 10))
      expect(engine.active?.id).equals(9)
      tapped.onTouchMove!(event(6, 12))
      tapped.onTouchEnd!(event(6, 12))
      await flush()
      expect(engine.active).equals(null)
      expect(taps).deep.equals([9])
      tapped.dispose()
      // A grip touch on a card that cannot be dragged starts nothing.
      const disabled = rosterResponder(engine, {
        children: null,
        playerId: 8,
        disabled: true
      })
      disabled.grip()
      disabled.onTouchStart!(event(4, 10))
      expect(engine.active).equals(null)
      disabled.dispose()
    } finally {
      handlers.dispose()
    }
  })
  it('makes the grip its own responder, which a list cannot take, and tells its card a touch started there (N2)', async function () {
    const engine = new RosterGesture(() => undefined)
    const list: string[] = []
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterContext.Provider value={engine}>
            {/* A list that wants every touch that moves, before its rows. */}
            <View
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponderCapture={() => true}
              onResponderGrant={() => {
                list.push('grant')
              }}
              onResponderReject={() => {
                list.push('reject')
              }}
            >
              <RosterDrag playerId={7} label="Seven">
                <RosterGrip label="Drag Seven" color="rgb(1, 2, 3)" />
                <Text>Seven</Text>
              </RosterDrag>
            </View>
          </RosterContext.Provider>
        </ThemeProvider>
      )
    })
    const glyph = host.querySelector<HTMLElement>('[aria-label="Drag Seven"]')!
    expect(glyph.textContent).equals('≡')
    expect(getComputedStyle(glyph).color).equals('rgb(1, 2, 3)')
    const grip = glyph.parentElement!
    // The card's whole height and its left padding.
    expect(grip.style.marginTop).equals('-10px')
    expect(grip.style.marginLeft).equals('-8px')
    const touch = async (target: Element, type: string): Promise<void> => {
      const e = new window.Event(type, { bubbles: true, cancelable: true })
      const point = { identifier: 1, clientX: 4, clientY: 20, pageX: 4 }
      if (type === 'touchmove') point.clientY = point.pageX = 40
      Object.defineProperties(e, {
        touches: { value: type === 'touchend' ? [] : [point] },
        changedTouches: { value: [point] }
      })
      await act(async () => {
        target.dispatchEvent(e)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    await touch(glyph, 'touchstart')
    expect(engine.active?.id).equals(7)
    await touch(glyph, 'touchmove')
    // The list asked for the touch and was refused it.
    expect(list).deep.equals(['reject'])
    await touch(glyph, 'touchend')
    expect(engine.active).equals(null)
    // Anywhere else on the card holds first.
    const name = [...host.querySelectorAll('[dir="auto"]')].find(
      node => node.textContent === 'Seven'
    )!
    await touch(name, 'touchstart')
    expect(engine.active).equals(null)
    await touch(name, 'touchend')
    document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  })
  it('supports native accessibility activation and reorder, rejecting disabled or unknown actions', function () {
    const deltas: number[] = []
    let taps = 0
    const props = {
      children: null,
      onTap: () => {
        taps++
      },
      onReorder: (delta: number) => {
        deltas.push(delta)
      }
    }
    for (const action of ['activate', 'increment', 'decrement', 'unknown'])
      rosterAccessibilityAction(props, action)
    rosterAccessibilityAction({ ...props, disabled: true }, 'activate')
    expect(taps).equals(1)
    expect(deltas).deep.equals([1, -1])
  })
  it('measures native views and uses equal halves for slider release', async function () {
    expect(await measureRosterView(null)).deep.equals({
      x: -10000,
      y: -10000,
      width: 0,
      height: 0
    })
    expect(rosterSegmentAt(20, 20, 320)).equals(0)
    expect(rosterSegmentAt(179, 20, 320)).equals(0)
    expect(rosterSegmentAt(180, 20, 320)).equals(1)
    expect(rosterSegmentAt(500, 20, 320)).equals(1)
  })

  it('lays a native item out as just its card, one gap from the next, and closes a lifted card to one gap', function () {
    const resting = rosterItemLayout(false, false)
    // No border or padding: the item is exactly as tall as its card.
    expect(Object.keys(resting).sort()).deep.equals([
      'borderRadius',
      'gap',
      'opacity'
    ])
    expect(resting).includes({ gap: ROSTER_CARD_GAP, opacity: 1 })
    expect(rosterItemLayout(true, false).marginBottom).equals(-ROSTER_CARD_GAP)
    expect(rosterItemLayout(false, true).opacity).equals(0.4)
  })
  it('registers a native card as a drag source and a drop target, and draws the hover ring or insertion line it is under', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: Array<[number, string | undefined]> = []
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterContext.Provider value={engine}>
            <RosterDrag targetId="roster">
              <RosterDrag playerId={3} label="Add Three to Lineup">
                <span>Three</span>
              </RosterDrag>
            </RosterDrag>
            <RosterDrag
              playerId={7}
              label="Reorder Seven"
              targetId="lineup-0"
              insertion="row"
              onDropPlayer={(id, edge) => drops.push([id, edge])}
              onReorder={() => undefined}
            >
              <span>Seven</span>
            </RosterDrag>
            <RosterDrag
              targetId="defense-P"
              onDropPlayer={id => drops.push([id, 'P'])}
            >
              <span>Unassigned</span>
            </RosterDrag>
          </RosterContext.Provider>
        </ThemeProvider>
      )
    })
    expect(host.textContent).includes('Three')
    expect(engine.sources.size).equals(2)
    expect([...engine.targets.keys()].sort()).deep.equals([
      'defense-P',
      'lineup-0'
    ])
    for (const card of engine.sources.values())
      expect(await card.measure()).to.have.keys('x', 'y', 'width', 'height')
    expect(await engine.targets.get('lineup-0')!.measure()).to.have.keys(
      'x',
      'y',
      'width',
      'height'
    )
    engine.targets.get('lineup-0')!.drop(3, 'after')
    engine.targets.get('defense-P')!.drop(4)
    expect(drops).deep.equals([
      [3, 'after'],
      [4, 'P']
    ])
    const hover = async (preview: RosterGesture['preview']): Promise<void> => {
      engine.preview = preview
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    await hover({
      x: 0,
      y: 0,
      label: 'Three',
      target: 'lineup-0',
      edge: 'before'
    })
    expect(
      host.querySelectorAll('[aria-label="Lineup insertion point"]')
    ).length(1)
    await hover({
      x: 0,
      y: 0,
      label: 'Three',
      target: 'lineup-0',
      edge: 'after'
    })
    expect(
      host.querySelectorAll('[aria-label="Lineup insertion point"]')
    ).length(1)
    await hover({ x: 0, y: 0, label: 'Three', target: 'defense-P' })
    expect(
      host.querySelectorAll('[aria-label="Lineup insertion point"]')
    ).length(0)
    await hover(null)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(engine.sources.size).equals(0)
    expect(engine.targets.size).equals(0)
  })
})
