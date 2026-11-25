import { expect } from 'chai'

import { remainingCredits, slotsLeft } from './sponsorRules'
import { initialsTile, SPONSOR_TOTALS, sponsorSeed } from './sponsorSeed'
import {
  createMockSponsorStore,
  SponsorRuleError,
  type SponsorStore,
  sponsorStoreFor
} from './sponsorStore'
import type { PickedFile, PlacementDraft, SponsorState } from './sponsorTypes'

const NOW = new Date('2026-11-24T20:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const file = (name: string, type: string): PickedFile => ({
  name,
  type,
  size: 1024,
  url: `blob:${name}`
})
const png = file('Bayside Bakery.png', 'image/png')
const jpeg = file('field.jpg', 'image/jpeg')
const webm = file('Bayside reel.webm', 'video/webm')

const draft = (patch: Partial<PlacementDraft> = {}): PlacementDraft => ({
  logo: png,
  background: jpeg,
  title: 'Bayside Bakery',
  message: 'Fresh rolls at the snack bar every Saturday.',
  url: 'https://bayside-bakery.example',
  startsAt: '2026-12-02T17:30:00.000Z',
  ...patch
})

/** A store whose clock the test moves. */
function clocked(seed: 'sample' | 'empty' = 'sample'): {
  store: SponsorStore
  advance: (ms: number) => void
} {
  let time = NOW.getTime()
  const store = createMockSponsorStore({ now: () => new Date(time), seed })
  return {
    store,
    advance: (ms: number) => {
      time += ms
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

/** Rejects with a SponsorRuleError and leaves the state as it was. */
async function refused(
  store: SponsorStore,
  change: Promise<SponsorState>,
  message: string
): Promise<void> {
  const before = await store.read()
  const error = await rejection(change)
  expect(error).instanceOf(SponsorRuleError)
  expect(error.name).equals('SponsorRuleError')
  expect(error.message).contains(message)
  expect(await store.read()).equals(before)
}

describe('sponsorStore U4', () => {
  it('seeds the rows and totals in the design table', async () => {
    const state = await clocked().store.read()
    expect(state.totals).deep.equals({
      logoCredits: 300,
      reelCredits: 1000,
      eventSlots: 10
    })
    expect(
      state.logos.map(({ name, allocation, used, active }) => ({
        name,
        allocation,
        used,
        active
      }))
    ).deep.equals([
      { name: 'Harbor Hardware', allocation: 100, used: 42, active: true },
      { name: 'Summit Dental', allocation: 50, used: 0, active: true },
      { name: 'Lakeside Pizza', allocation: 30, used: 30, active: false }
    ])
    expect(
      state.reels.map(({ name, durationSec, allocation, used, active }) => ({
        name,
        durationSec,
        allocation,
        used,
        active
      }))
    ).deep.equals([
      {
        name: 'Harbor Hardware',
        durationSec: 12,
        allocation: 400,
        used: 120,
        active: true
      },
      {
        name: 'Ridgeview Auto',
        durationSec: 15,
        allocation: 100,
        used: 0,
        active: true
      }
    ])
    expect(remainingCredits(300, state.logos)).equals(120)
    expect(remainingCredits(1000, state.reels)).equals(500)
    const [summit, lakeside] = state.placements
    expect(summit.title).equals('Summit Dental')
    expect(Date.parse(summit.placedAt)).equals(NOW.getTime() - 3 * DAY)
    expect(Date.parse(summit.startsAt)).equals(NOW.getTime() + 5 * DAY)
    expect(lakeside.title).equals('Lakeside Pizza')
    expect(Date.parse(lakeside.placedAt)).equals(NOW.getTime() - 2 * HOUR)
    expect(Date.parse(lakeside.startsAt)).equals(NOW.getTime() + 9 * DAY)
    expect(slotsLeft(state)).equals(8)
    for (const logo of state.logos)
      expect(logo.imageUrl).match(/^data:image\/svg\+xml/)
    expect(initialsTile('HH', '#000')).contains(encodeURIComponent('>HH<'))
  })

  it('resolves each mutation with the new state and tells subscribers', async () => {
    const { store } = clocked()
    const seen: SponsorState[] = []
    const stop = store.subscribe(state => seen.push(state))

    let state = await store.addLogo({ picked: png, allocation: 20 })
    const added = state.logos[3]
    expect(added).to.include({
      name: 'Bayside Bakery',
      imageUrl: 'blob:Bayside Bakery.png',
      version: 1,
      allocation: 20,
      used: 0,
      active: true
    })
    expect(remainingCredits(300, state.logos)).equals(100)
    state = await store.changeLogo(added.id, file('new.png', 'image/png'))
    expect(state.logos[3]).to.include({ imageUrl: 'blob:new.png', version: 2 })
    state = await store.setLogoAllocation(added.id, 25)
    expect(state.logos[3].allocation).equals(25)
    state = await store.deactivateLogo('logo-harbor-hardware')
    expect(state.logos[0].active).equals(false)
    state = await store.deactivateLogo(added.id)
    expect(state.logos.map(logo => logo.id)).not.contains(added.id)

    state = await store.addReel({
      picked: webm,
      durationSec: 12.5,
      allocation: 100
    })
    const reel = state.reels[2]
    expect(reel).to.include({
      name: 'Bayside reel',
      videoUrl: 'blob:Bayside reel.webm',
      posterUrl: '',
      durationSec: 12.5,
      allocation: 100,
      version: 1
    })
    expect(remainingCredits(1000, state.reels)).equals(400)
    state = await store.changeReel(reel.id, file('cut.mp4', 'video/mp4'), 10)
    expect(state.reels[2]).to.include({
      videoUrl: 'blob:cut.mp4',
      durationSec: 10,
      version: 2
    })
    state = await store.setReelAllocation('reel-harbor-hardware', 120)
    expect(state.reels[0].allocation).equals(120)
    state = await store.deactivateReel('reel-ridgeview-auto')
    expect(state.reels.map(each => each.id)).not.contains('reel-ridgeview-auto')

    state = await store.addPlacement(draft())
    const placement = state.placements[2]
    expect(placement).to.include({
      logoUrl: 'blob:Bayside Bakery.png',
      backgroundUrl: 'blob:field.jpg',
      title: 'Bayside Bakery',
      startsAt: '2026-12-02T17:30:00.000Z',
      placedAt: NOW.toISOString()
    })
    expect(slotsLeft(state)).equals(7)
    state = await store.editPlacement(
      placement.id,
      draft({ logo: null, background: null, title: 'Bayside rolls' })
    )
    expect(state.placements[2]).to.include({
      title: 'Bayside rolls',
      logoUrl: 'blob:Bayside Bakery.png',
      placedAt: NOW.toISOString()
    })
    state = await store.deletePlacement(placement.id)
    expect(slotsLeft(state)).equals(8)

    expect(seen).length(12)
    expect(seen[11]).equals(state)
    stop()
    await store.deletePlacement('placement-lakeside-pizza')
    expect(seen).length(12)
    expect(slotsLeft(await store.read())).equals(9)
  })

  it('rejects a broken rule with SponsorRuleError and keeps the state', async () => {
    const { store } = clocked()
    await refused(
      store,
      store.addLogo({ picked: jpeg, allocation: 10 }),
      'Logos must be PNG files.'
    )
    await refused(
      store,
      store.addLogo({ picked: png, allocation: 121 }),
      'Only 120 game logo credits'
    )
    await refused(
      store,
      store.changeLogo('logo-lakeside-pizza', png),
      'inactive'
    )
    await refused(store, store.changeLogo('logo-summit-dental', jpeg), 'PNG')
    await refused(
      store,
      store.setLogoAllocation('logo-harbor-hardware', 41),
      'has used 42'
    )
    await refused(store, store.deactivateLogo('logo-missing'), 'no longer')
    await refused(
      store,
      store.addReel({ picked: png, durationSec: 12, allocation: 10 }),
      'Choose a video file.'
    )
    await refused(
      store,
      store.addReel({ picked: webm, durationSec: 20, allocation: 10 }),
      'This reel is 20 seconds.'
    )
    await refused(
      store,
      store.addReel({ picked: webm, durationSec: 12, allocation: 501 }),
      'Only 500 broadcast credits'
    )
    await refused(
      store,
      store.changeReel('reel-harbor-hardware', webm, NaN),
      'could not be read'
    )
    await refused(
      store,
      store.changeReel('reel-harbor-hardware', jpeg, 12),
      'Choose a video file.'
    )
    await refused(
      store,
      store.setReelAllocation('reel-ridgeview-auto', 0),
      'whole number'
    )
    await refused(store, store.deactivateReel('reel-missing'), 'no longer')
    await refused(
      store,
      store.addPlacement(draft({ title: 'x'.repeat(21), url: 'http://a.b' })),
      'Titles can be at most 20 characters. Use an https:// address.'
    )
    await refused(
      store,
      store.addPlacement(draft({ logo: null })),
      'Choose a logo image.'
    )
    await refused(
      store,
      store.editPlacement('placement-summit-dental', draft()),
      'can only be deleted'
    )
    await refused(
      store,
      store.editPlacement('placement-lakeside-pizza', draft({ message: '' })),
      'Enter a message.'
    )
    await refused(
      store,
      store.deletePlacement('placement-missing'),
      'no longer'
    )
  })

  it('applies the 24-hour window with its clock', async () => {
    const { store, advance } = clocked('empty')
    let state = await store.addPlacement(draft())
    const { id } = state.placements[0]
    advance(23 * HOUR + 59 * 60 * 1000)
    state = await store.editPlacement(id, draft({ title: 'Still open' }))
    expect(state.placements[0].title).equals('Still open')
    advance(60 * 1000)
    await refused(
      store,
      store.editPlacement(id, draft()),
      'can only be deleted'
    )
    state = await store.deletePlacement(id)
    expect(state.keptSlots).equals(1)
    expect(slotsLeft(state)).equals(9)
  })

  it('accepts an edit inside the window at 0 slots and refuses an add', async () => {
    const { store } = clocked('empty')
    let state = await store.read()
    for (let index = 0; index < 10; index++)
      state = await store.addPlacement(draft({ title: `Slot ${index + 1}` }))
    expect(slotsLeft(state)).equals(0)
    await refused(store, store.addPlacement(draft()), 'All event stream slots')
    state = await store.editPlacement(
      state.placements[0].id,
      draft({ title: 'Moved', startsAt: '2026-12-09T17:30:00.000Z' })
    )
    expect(state.placements[0]).to.include({
      title: 'Moved',
      startsAt: '2026-12-09T17:30:00.000Z'
    })
    expect(slotsLeft(state)).equals(0)
  })

  it("keeps the totals on reset('empty') and restores the seed on reset('sample')", async () => {
    const { store } = clocked()
    await store.addLogo({ picked: png, allocation: 10 })
    let state = await store.reset('empty')
    expect(state).deep.equals({
      totals: SPONSOR_TOTALS,
      logos: [],
      reels: [],
      placements: [],
      keptSlots: 0
    })
    state = await store.reset('sample')
    expect(state).deep.equals(sponsorSeed(NOW))
  })

  it('names a picked file without an extension by its whole name', async () => {
    const { store } = clocked('empty')
    const state = await store.addLogo({
      picked: { ...png, name: '.png' },
      allocation: 1
    })
    expect(state.logos[0].name).equals('.png')
  })

  it('uses the real clock and the sample seed by default', async () => {
    const before = Date.now()
    const state = await createMockSponsorStore().read()
    expect(state.logos).length(3)
    expect(Date.parse(state.placements[1].placedAt)).within(
      before - 2 * HOUR - 1000,
      Date.now() - 2 * HOUR + 1000
    )
  })

  it('gives one store per league', () => {
    const first = sponsorStoreFor('lg_one')
    expect(sponsorStoreFor('lg_one')).equals(first)
    expect(sponsorStoreFor('lg_two')).not.equals(first)
  })
})
