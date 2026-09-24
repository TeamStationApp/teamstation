import { expect } from 'chai'
import { describe, it } from 'mocha'

import { RosterGesture, type RosterPreview } from './rosterGesture'

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
})
