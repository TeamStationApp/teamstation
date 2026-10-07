import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GestureResponderEvent } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import {
  rosterAccessibilityAction,
  RosterDrag,
  rosterItemLayout,
  rosterResponder
} from './RosterDrag.native'
import { measureRosterView, RosterContext } from './RosterDragContext'
import { RosterGesture } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'
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
