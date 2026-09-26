import { expect } from 'chai'
import { describe, it } from 'mocha'

import { RosterGesture, type RosterPreview } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'

const box = { x: 100, y: 100, width: 100, height: 200 }
describe('shared roster dragging', function () {
  it('distinguishes taps, valid drops, invalid releases and clipped targets', async function () {
    const previews: Array<RosterPreview | null> = []
    const drops: number[] = []
    const engine = new RosterGesture(p => previews.push(p))
    engine.targets.set('row', {
      measure: async () => box,
      drop: id => drops.push(id)
    })
    await engine.move({ x: 120, y: 120 })
    expect(await engine.release({ x: 120, y: 120 })).equals(false)
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.move({ x: 3, y: 4 })
    expect(await engine.release({ x: 120, y: 120 })).equals(false)
    expect(drops).deep.equals([])
    engine.begin(2, 'Two', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 120 })
    expect(previews.at(-1)?.target).equals('row')
    expect(await engine.release({ x: 120, y: 120 })).equals(true)
    expect(drops).deep.equals([2])
    engine.begin(3, 'Three', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 120 })
    await engine.release({ x: 400, y: 400 })
    engine.targets.get('row')!.clip = async () => ({ ...box, height: 10 })
    engine.begin(4, 'Four', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 120 })
    expect(previews.at(-1)?.target).equals(undefined)
    await engine.release({ x: 120, y: 120 })
    expect(drops).deep.equals([2])
    expect(engine.active).equals(null)
  })
  it('chooses the smallest nested target and uses fresh bounds on release', async function () {
    const drops: string[] = []
    const engine = new RosterGesture(() => undefined)
    engine.targets.set('column', {
      measure: async () => box,
      drop: () => drops.push('column')
    })
    let y = 110
    engine.targets.set('row', {
      measure: async () => ({ ...box, y, height: 40 }),
      drop: () => drops.push('row')
    })
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 120 })
    y = 200
    await engine.release({ x: 120, y: 120 })
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 220 })
    await engine.release({ x: 120, y: 220 })
    expect(drops).deep.equals(['column', 'row'])
  })
  it('discards stale asynchronous hover and release after team/mode cancellation', async function () {
    const previews: Array<RosterPreview | null> = []
    const drops: number[] = []
    const pending: Array<() => void> = []
    const engine = new RosterGesture(p => previews.push(p))
    engine.targets.set('row', {
      measure: async () =>
        await new Promise(resolve =>
          pending.push(() => {
            resolve(box)
          })
        ),
      drop: id => drops.push(id)
    })
    engine.begin(1, 'One', { x: 0, y: 0 })
    const move = engine.move({ x: 120, y: 120 })
    const release = engine.release({ x: 120, y: 120 })
    engine.cancel()
    for (const resolve of pending) resolve()
    await move
    expect(await release).equals(true)
    expect(previews.at(-1)).equals(null)
    expect(drops).deep.equals([])
  })
  it('previews insertion edges and recomputes them at release', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: Array<string | undefined> = []
    engine.targets.set('lineup', {
      measure: async () => box,
      insertion: 'row',
      drop: (_, edge) => drops.push(edge)
    })
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 120 })
    expect(engine.preview?.edge).equals('before')
    await engine.move({ x: 120, y: 220 })
    expect(engine.preview?.edge).equals('after')
    await engine.release({ x: 120, y: 120 })
    expect(drops).deep.equals(['before'])
    engine.targets.get('lineup')!.insertion = 'end'
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.move({ x: 120, y: 220 })
    expect(engine.preview?.edge).equals('before')
    await engine.release({ x: 120, y: 220 })
    expect(engine.preview).equals(null)
  })
  it('auto-scrolls only an active drag at a visible edge and remeasures', async function () {
    const deltas: number[] = []
    const engine = new RosterGesture(() => undefined)
    engine.scrolls.set('list', {
      measure: async () => box,
      scroll: delta => deltas.push(delta)
    })
    await engine.tick()
    engine.begin(1, 'One', { x: 0, y: 0 })
    await engine.tick()
    for (const point of [
      { x: 120, y: 110 },
      { x: 120, y: 290 },
      { x: 120, y: 200 },
      { x: 500, y: 290 }
    ]) {
      await engine.move(point)
      await engine.tick()
    }
    expect(deltas).deep.equals([-18, 18])
    engine.scrolls.set('list', {
      measure: async () => {
        engine.cancel()
        return box
      },
      scroll: delta => deltas.push(delta)
    })
    await engine.tick()
    expect(deltas).deep.equals([-18, 18])
  })
  it('freezes full-card geometry, keeps the grab offset and follows scroll without gap feedback', async function () {
    const engine = new RosterGesture(() => undefined)
    const observed: Array<RosterPreview | null> = []
    engine.listeners.add(p => observed.push(p))
    const clip = async (): Promise<typeof box> => ({
      x: 0,
      y: 0,
      width: 300,
      height: 500
    })
    let offset = 0
    let targetY = 100
    const drops: Array<[number, string | undefined]> = []
    engine.scrolls.set('lineup', {
      measure: clip,
      offset: () => offset,
      scroll: dy => {
        offset += dy
      }
    })
    engine.sources.set('source', {
      measure: async () => ({ x: 100, y: 40, width: 120, height: 48 }),
      clip,
      content: 'full card'
    })
    engine.targets.set('lineup-source', {
      measure: async () => ({ x: 100, y: 40, width: 120, height: 48 }),
      clip,
      insertion: 'row',
      drop: () => {
        throw new Error('source cannot receive itself')
      }
    })
    engine.targets.set('lineup-1', {
      measure: async () => ({ x: 100, y: targetY, width: 120, height: 48 }),
      clip,
      insertion: 'row',
      drop: (id, edge) => drops.push([id, edge])
    })
    engine.begin(7, 'Seven', { x: 111, y: 53 }, true, 'source')
    await engine.move({ x: 120, y: 55 })
    expect(engine.preview?.cardRect).deep.equals({
      x: 100,
      y: 40,
      width: 120,
      height: 48
    })
    expect(engine.preview?.grab).deep.equals({ x: 11, y: 13 })
    expect(engine.preview?.target).equals('lineup-1')
    expect(engine.preview?.edge).equals('before')
    targetY = 250 // opening the preview gap cannot move its logical target
    await engine.move({ x: 120, y: 80 })
    expect(engine.preview?.edge).equals('after')
    offset = 20
    await engine.move({ x: 120, y: 35 })
    expect(engine.preview?.target).equals('lineup-1')
    expect(engine.preview?.edge).equals('before')
    await engine.release({ x: 120, y: 35 })
    expect(drops).deep.equals([[7, 'before']])
    expect(observed.at(-1)).equals(null)
    engine.begin(7, 'Seven', { x: 111, y: 53 }, true, 'source')
    await engine.move({ x: 450, y: 35 })
    expect(engine.preview?.target).equals(undefined)
    engine.cancel()
    expect(engine.preview).equals(null)
  })
  it('closes the gap a dragged card leaves by its height plus the card gap', async function () {
    const engine = new RosterGesture(() => undefined)
    const clip = async (): Promise<typeof box> => ({
      x: 0,
      y: 0,
      width: 300,
      height: 500
    })
    engine.sources.set('source', {
      measure: async () => ({ x: 100, y: 40, width: 120, height: 48 }),
      clip,
      content: 'full card'
    })
    // The next card down, one card and one gap below the dragged one.
    const below = 40 + 48 + ROSTER_CARD_GAP
    engine.targets.set('lineup-1', {
      measure: async () => ({ x: 100, y: below, width: 120, height: 48 }),
      clip,
      insertion: 'row',
      drop: () => undefined
    })
    engine.begin(7, 'Seven', { x: 111, y: 53 }, true, 'source')
    // With the dragged card lifted out, the next card moves up into its place:
    // its top is exactly where the dragged card's top was.
    await engine.move({ x: 120, y: 40 })
    expect(engine.preview?.target).equals('lineup-1')
    await engine.move({ x: 120, y: 39 })
    expect(engine.preview?.target).equals(undefined)
    engine.cancel()
  })

  it('ignores stale source measurements and cancels failed measurements', async function () {
    const engine = new RosterGesture(() => undefined)
    let finish!: (value: typeof box) => void
    engine.sources.set('source', {
      measure: async () =>
        await new Promise(resolve => {
          finish = resolve
        }),
      content: null
    })
    engine.begin(1, 'One', { x: 0, y: 0 }, true, 'source')
    engine.cancel()
    finish(box)
    await engine.move({ x: 10, y: 10 })
    expect(engine.preview).equals(null)
    engine.sources.set('source', {
      measure: async () => {
        throw new Error('unmounted')
      },
      content: null
    })
    engine.begin(1, 'One', { x: 0, y: 0 }, true, 'source')
    await engine.move({ x: 10, y: 10 })
    expect(engine.active).equals(null)
  })
})
