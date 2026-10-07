import { expect } from 'chai'
import { describe, it } from 'mocha'

import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { RosterGesture, type RosterPreview } from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'

const box = { x: 100, y: 100, width: 100, height: 200 }
describe('shared roster dragging', function () {
  it('spaces roster cards one rem apart, the body text size in both themes', function () {
    expect(ROSTER_CARD_GAP).equals(16)
    expect(ROSTER_CARD_GAP).equals(tsBallpark.rem(1))
    expect(ROSTER_CARD_GAP).equals(tsDark.rem(1))
  })
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
  it('splits the gap between two lineup cards between them, so a release there is never lost', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: string[] = []
    for (const [key, y] of [
      ['lineup-0', 100],
      ['lineup-1', 100 + 48 + ROSTER_CARD_GAP]
    ] as const)
      engine.targets.set(key, {
        measure: async () => ({ x: 100, y, width: 200, height: 48 }),
        insertion: 'row',
        drop: (_, edge) => drops.push(`${key} ${edge}`)
      })
    const middle = 148 + ROSTER_CARD_GAP / 2
    for (const y of [
      100 - ROSTER_CARD_GAP / 2,
      middle - 1,
      middle + 1,
      100 - ROSTER_CARD_GAP / 2 - 1
    ]) {
      engine.begin(1, 'One', { x: 0, y: 0 })
      await engine.move({ x: 150, y })
      await engine.release({ x: 150, y })
    }
    expect(drops).deep.equals([
      'lineup-0 before',
      'lineup-0 after',
      'lineup-1 before'
    ])
  })
  it('splits the gap between two defensive positions between them as well', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: string[] = []
    for (const [key, y] of [
      ['defense-P', 100],
      ['defense-C', 100 + 48 + ROSTER_CARD_GAP]
    ] as const)
      engine.targets.set(key, {
        measure: async () => ({ x: 100, y, width: 200, height: 48 }),
        drop: () => drops.push(key)
      })
    const middle = 148 + ROSTER_CARD_GAP / 2
    for (const y of [middle - 1, middle + 1]) {
      engine.begin(1, 'One', { x: 0, y: 0 })
      await engine.move({ x: 150, y })
      await engine.release({ x: 150, y })
    }
    expect(drops).deep.equals(['defense-P', 'defense-C'])
  })
  it('takes a drop anywhere below the top of the end target, inside its list, as the end', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: string[] = []
    const clip = async (): Promise<typeof box> => ({
      x: 100,
      y: 0,
      width: 200,
      height: 600
    })
    engine.targets.set('lineup-0', {
      measure: async () => ({ x: 100, y: 100, width: 200, height: 48 }),
      clip,
      insertion: 'row',
      drop: () => drops.push('row')
    })
    engine.targets.set('lineup-end', {
      measure: async () => ({ x: 100, y: 164, width: 200, height: 73 }),
      clip,
      insertion: 'end',
      drop: (_, edge) => drops.push(`end ${edge}`)
    })
    for (const y of [170, 236, 400, 599]) {
      engine.begin(1, 'One', { x: 0, y: 0 })
      await engine.move({ x: 150, y })
      expect(engine.preview?.target).equals('lineup-end')
      await engine.release({ x: 150, y })
    }
    // The gap between the last card and the end target is split between
    // them; below the list nothing takes the drop.
    for (const [y, target] of [
      [152, 'lineup-0'],
      [160, 'lineup-end'],
      [700, undefined]
    ] as const) {
      engine.begin(1, 'One', { x: 0, y: 0 })
      await engine.move({ x: 150, y })
      expect(engine.preview?.target).equals(target)
      await engine.release({ x: 150, y })
    }
    expect(drops).deep.equals([
      'end before',
      'end before',
      'end before',
      'end before',
      'row',
      'end before'
    ])
  })
  it('keeps an end target with no list to bound it to its own card and half gaps', async function () {
    const engine = new RosterGesture(() => undefined)
    const drops: number[] = []
    engine.targets.set('lineup-end', {
      measure: async () => ({ x: 100, y: 164, width: 200, height: 73 }),
      insertion: 'end',
      drop: id => drops.push(id)
    })
    for (const y of [237 + ROSTER_CARD_GAP / 2 - 1, 400]) {
      engine.begin(1, 'One', { x: 0, y: 0 })
      await engine.move({ x: 150, y })
      await engine.release({ x: 150, y })
    }
    expect(drops).deep.equals([1])
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
    engine.begin(7, 'Seven', { x: 111, y: 53 }, 'source')
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
    engine.begin(7, 'Seven', { x: 111, y: 53 }, 'source')
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
    engine.begin(7, 'Seven', { x: 111, y: 53 }, 'source')
    // With the dragged card lifted out, the next card moves up into its place:
    // its top is exactly where the dragged card's top was, and it takes half
    // a gap above that.
    await engine.move({ x: 120, y: 40 - ROSTER_CARD_GAP / 2 })
    expect(engine.preview?.target).equals('lineup-1')
    await engine.move({ x: 120, y: 39 - ROSTER_CARD_GAP / 2 })
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
    engine.begin(1, 'One', { x: 0, y: 0 }, 'source')
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
    engine.begin(1, 'One', { x: 0, y: 0 }, 'source')
    await engine.move({ x: 10, y: 10 })
    expect(engine.active).equals(null)
  })
})
