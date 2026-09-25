import { expect } from 'chai'
import { describe, it } from 'mocha'
import type { GestureResponderEvent } from 'react-native'

import { rosterAccessibilityAction, rosterResponder } from './RosterDrag.native'
import { measureRosterView } from './RosterDragContext'
import { RosterGesture } from './rosterGesture'
import { rosterSegmentAt } from './RosterSelector'

const event = (x: number, y: number): GestureResponderEvent =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({ nativeEvent: { pageX: x, pageY: y } }) as GestureResponderEvent
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}
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
})
