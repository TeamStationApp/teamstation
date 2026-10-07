import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  RosterCardSlot,
  rosterSlotCardStyle,
  rosterSlotLayout
} from './RosterCardSlot'
import { RosterContext } from './RosterDragContext'
import { RosterGesture, type RosterPreview } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'

const card = { x: 0, y: 0, width: 160, height: 48 }
const lifted = (
  over: Partial<RosterPreview> = {}
): RosterPreview & { cardRect: typeof card } => ({
  x: 0,
  y: 0,
  label: 'Seven',
  source: 'held',
  cardRect: card,
  ...over
})
const layout = (
  preview: RosterPreview | null,
  slot: { source?: string; target?: string; player?: number } = {},
  reduced = false
): ReturnType<typeof rosterSlotLayout> =>
  rosterSlotLayout({
    preview,
    source: slot.source ?? 'other',
    target: slot.target,
    player: slot.player,
    height: 49,
    reduced
  })

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

describe('roster card slot', function () {
  it('closes a lifted card and opens one card and one gap on the lineup card under the pointer', function () {
    const source = layout(lifted(), { source: 'held', player: 7 })
    expect(source).includes({ height: 0, opacity: 0, duration: 160 })
    const before = layout(lifted({ target: 'lineup-3', edge: 'before' }), {
      target: 'lineup-3',
      player: 4
    })
    expect(before).includes({
      height: 49,
      marginTop: card.height + ROSTER_CARD_GAP,
      marginBottom: 0,
      opacity: 1
    })
    const after = layout(lifted({ target: 'lineup-3', edge: 'after' }), {
      target: 'lineup-3',
      player: 4
    })
    expect(after).includes({
      marginTop: 0,
      marginBottom: card.height + ROSTER_CARD_GAP
    })
    // The lifted card never opens a gap on itself, nor a non-lineup target.
    expect(
      layout(lifted({ target: 'lineup-3' }), {
        source: 'held',
        target: 'lineup-3',
        player: 7
      })
    ).includes({ height: 0, marginTop: 0, marginBottom: 0 })
    expect(
      layout(lifted({ target: 'defense-P' }), { target: 'defense-P' })
    ).includes({ marginTop: 0, marginBottom: 0 })
    expect(
      layout(lifted(), { source: 'held', player: 7 }, true).duration
    ).equals(0)
  })

  it('settles every slot at once at its measured height when there is no drag', function () {
    for (const slot of [
      { source: 'held', player: 7 },
      { target: 'lineup-3', player: 4 },
      { target: 'lineup-end' }
    ])
      expect(layout(null, slot)).deep.equals({
        animated: true,
        height: 49,
        marginTop: 0,
        marginBottom: 0,
        opacity: 1,
        duration: 0
      })
    // A preview that has not measured its card yet changes nothing.
    expect(
      layout(lifted({ cardRect: undefined }), { source: 'held', player: 7 })
    ).includes({ height: 49, opacity: 1 })
  })

  it('lays the card out of flow in an animated slot, and in flow where the slot does not animate', async function () {
    expect(rosterSlotCardStyle(true)).deep.equals({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0
    })
    expect(rosterSlotCardStyle(false)).deep.equals({})
    expect(layout(null, { target: 'defense-P' }).animated).equals(false)
    expect(layout(null, { player: 3 }).animated).equals(true)
    const engine = new RosterGesture(() => undefined)
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <RosterContext.Provider value={engine}>
          <div data-slot="lineup">
            <RosterCardSlot source="a" target="lineup-0" player={1}>
              <span>One</span>
            </RosterCardSlot>
          </div>
          <div data-slot="defense">
            <RosterCardSlot source="b" target="defense-P">
              <span>Pitcher</span>
            </RosterCardSlot>
          </div>
        </RosterContext.Provider>
      )
    })
    const cardView = (slot: string): HTMLElement =>
      host.querySelector(`[data-slot="${slot}"]`)!.firstElementChild!
        .firstElementChild as HTMLElement
    expect(cardView('lineup').style.position).equals('absolute')
    expect(cardView('defense').style.position).not.equals('absolute')
    // A drag that lifts and drops the card leaves it visible in its slot.
    await act(async () => {
      engine.preview = lifted({ source: 'a' })
      for (const listen of engine.listeners) listen(engine.preview)
    })
    expect(cardView('lineup').style.opacity).equals('0')
    await act(async () => {
      engine.preview = null
      for (const listen of engine.listeners) listen(null)
    })
    expect(cardView('lineup').style.opacity).equals('1')
  })
})
