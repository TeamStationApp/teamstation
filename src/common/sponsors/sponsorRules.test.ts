import { expect } from 'chai'

import {
  allocated,
  allocationProblem,
  canEditPlacement,
  characters,
  checkPlacementEdit,
  checkPlacementSlot,
  deactivated,
  imageFileProblem,
  logoFileProblem,
  messageProblem,
  placementDeleted,
  placementProblems,
  reelFileProblem,
  reelLengthProblem,
  remainingCredits,
  slotsLeft,
  SponsorRuleError,
  startsAtProblem,
  titleProblem,
  urlProblem
} from './sponsorRules'
import type { PlacementDraft, SponsorState } from './types'

const NOW = new Date('2026-11-24T20:00:00.000Z')
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

const png = { name: 'logo.png', type: 'image/png', size: 10, url: 'blob:a' }
const jpeg = { name: 'back.jpg', type: 'image/jpeg', size: 10, url: 'blob:b' }
const gif = { name: 'anim.gif', type: 'image/gif', size: 10, url: 'blob:c' }

const draft = (patch: Partial<PlacementDraft> = {}): PlacementDraft => ({
  logo: png,
  background: jpeg,
  title: 'Harbor Hardware',
  message: 'Ten percent off for league families.',
  url: 'https://example.com',
  startsAt: '2026-12-01T18:00:00.000Z',
  ...patch
})

const DAY = 24 * HOUR

/** Two logos and an inactive one, two reels, and two placed rows. */
const seed = (): SponsorState => {
  const at = (offsetMs: number): string =>
    new Date(NOW.getTime() + offsetMs).toISOString()
  return {
    totals: { logoCredits: 300, reelCredits: 1000, eventSlots: 10 },
    logos: [
      {
        id: 'logo-harbor-hardware',
        name: 'Harbor Hardware',
        imageUrl: 'https://media.example.test/hh.png',
        allocation: 100,
        used: 42,
        active: true
      },
      {
        id: 'logo-summit-dental',
        name: 'Summit Dental',
        imageUrl: 'https://media.example.test/sd.png',
        allocation: 50,
        used: 0,
        active: true
      },
      {
        id: 'logo-lakeside-pizza',
        name: 'Lakeside Pizza',
        imageUrl: 'https://media.example.test/lp.png',
        allocation: 30,
        used: 30,
        active: false
      }
    ],
    reels: [
      {
        id: 'reel-harbor-hardware',
        name: 'Harbor Hardware',
        videoUrl: 'https://media.example.test/hh.mp4',
        posterUrl: '',
        durationSec: 12,
        allocation: 400,
        used: 120,
        active: true
      },
      {
        id: 'reel-ridgeview-auto',
        name: 'Ridgeview Auto',
        videoUrl: 'https://media.example.test/ra.mp4',
        posterUrl: '',
        durationSec: 15,
        allocation: 100,
        used: 0,
        active: true
      }
    ],
    placements: [
      {
        id: 'placement-summit-dental',
        logoUrl: 'https://media.example.test/sd-logo.png',
        backgroundUrl: 'https://media.example.test/sd-back.jpg',
        title: 'Summit Dental',
        message: 'Free sports mouthguard fitting for every player this month.',
        url: 'https://summit-dental.example/mouthguards',
        startsAt: at(5 * DAY),
        placedAt: at(-3 * DAY)
      },
      {
        id: 'placement-lakeside-pizza',
        logoUrl: 'https://media.example.test/lp-logo.png',
        backgroundUrl: 'https://media.example.test/lp-back.jpg',
        title: 'Lakeside Pizza',
        message: 'Team night: 20% off for families who show their schedule.',
        url: 'https://lakeside-pizza.example/team-night',
        startsAt: at(9 * DAY),
        placedAt: at(-2 * HOUR)
      }
    ],
    keptSlots: 0
  }
}

/** A state whose only placement was placed `ageMs` before NOW. */
const placedAgo = (ageMs: number, extra = 0): SponsorState => {
  const state = seed()
  const [first] = state.placements
  return {
    ...state,
    placements: [
      { ...first, placedAt: new Date(NOW.getTime() - ageMs).toISOString() },
      ...Array.from({ length: extra }, (_, index) => ({
        ...first,
        id: `extra-${index}`
      }))
    ]
  }
}

describe('U1 sponsorRules', () => {
  describe('credits', () => {
    it('counts active and inactive allocations in the remaining credits', () => {
      const state = seed()
      expect(remainingCredits(state.totals.logoCredits, state.logos)).equals(
        120
      )
      expect(remainingCredits(state.totals.reelCredits, state.reels)).equals(
        500
      )
    })

    it('refuses 0, fractions, below used and one over the total', () => {
      const { logos } = seed()
      expect(allocationProblem(logos, 300, null, 0)).equals(
        'Enter a whole number of credits, at least 1.'
      )
      expect(allocationProblem(logos, 300, null, 2.5)).equals(
        'Enter a whole number of credits, at least 1.'
      )
      expect(allocationProblem(logos, 300, 'logo-harbor-hardware', 41)).equals(
        "Harbor Hardware has used 42; its pool can't be smaller."
      )
      expect(allocationProblem(logos, 300, null, 121)).equals(
        'Only 120 game logo credits are left to assign.'
      )
      expect(allocationProblem(logos, 300, 'logo-harbor-hardware', 221)).equals(
        'Only 220 game logo credits are left to assign.'
      )
      const { reels } = seed()
      expect(allocationProblem(reels, 1000, null, 501, 'broadcast')).equals(
        'Only 500 broadcast credits are left to assign.'
      )
    })

    it('accepts exactly the remaining amount, and the used count', () => {
      const { logos } = seed()
      expect(allocationProblem(logos, 300, null, 120)).equals(null)
      expect(allocationProblem(logos, 300, 'logo-harbor-hardware', 220)).equals(
        null
      )
      expect(allocationProblem(logos, 300, 'logo-harbor-hardware', 42)).equals(
        null
      )
    })

    it('says no credits are left when the rows already overspend', () => {
      const { logos } = seed()
      expect(allocationProblem(logos, 100, null, 1)).equals(
        'Only 0 game logo credits are left to assign.'
      )
    })

    it('refuses to re-allocate an inactive row', () => {
      const { logos } = seed()
      expect(allocationProblem(logos, 300, 'logo-lakeside-pizza', 40)).equals(
        "Lakeside Pizza is inactive; its pool can't change."
      )
      expect(() =>
        allocated(logos, 300, 'logo-lakeside-pizza', 40, 'game logo')
      ).to.throw(SponsorRuleError, 'inactive')
    })

    it('sets an allocation the rule accepts and throws on one it refuses', () => {
      const { logos } = seed()
      const rows = allocated(logos, 300, 'logo-summit-dental', 60, 'game logo')
      expect(
        rows.find(row => row.id === 'logo-summit-dental')?.allocation
      ).equals(60)
      expect(remainingCredits(300, rows)).equals(110)
      expect(() =>
        allocated(logos, 300, 'logo-summit-dental', 171, 'game logo')
      ).to.throw(SponsorRuleError, 'Only 170 game logo credits')
      expect(() =>
        allocated(logos, 300, 'logo-missing', 10, 'game logo')
      ).to.throw(SponsorRuleError, 'no longer listed')
    })

    it('keeps a used row inactive and removes an unused one', () => {
      const { logos } = seed()
      const used = deactivated(logos, 'logo-harbor-hardware')
      const harbor = used.find(row => row.id === 'logo-harbor-hardware')
      expect(harbor).to.include({ active: false, allocation: 100, used: 42 })
      expect(remainingCredits(300, used)).equals(120)

      const unused = deactivated(logos, 'logo-summit-dental')
      expect(unused.map(row => row.id)).deep.equals([
        'logo-harbor-hardware',
        'logo-lakeside-pizza'
      ])
      expect(remainingCredits(300, unused)).equals(170)
      expect(() => deactivated(logos, 'logo-missing')).to.throw(
        SponsorRuleError
      )
    })
  })

  describe('files and placements', () => {
    it('checks file types for logos, images and reels', () => {
      expect(logoFileProblem(png)).equals(null)
      expect(logoFileProblem(jpeg)).equals('Logos must be PNG files.')
      expect(imageFileProblem(jpeg)).equals(null)
      expect(imageFileProblem(png)).equals(null)
      expect(imageFileProblem(gif)).equals('Images must be JPEG or PNG.')
      expect(reelFileProblem({ type: 'video/webm' })).equals(null)
      expect(reelFileProblem({ type: 'image/png' })).equals(
        'Choose a video file.'
      )
    })

    it('accepts reels from 10 to 15 seconds', () => {
      for (const length of [10, 12.5, 15])
        expect(reelLengthProblem(length), String(length)).equals(null)
      expect(reelLengthProblem(9.9)).equals(
        'This reel is 9.9 seconds. Reels must be 10 to 15 seconds long.'
      )
      expect(reelLengthProblem(15.1)).equals(
        'This reel is 15.1 seconds. Reels must be 10 to 15 seconds long.'
      )
      expect(reelLengthProblem(20)).equals(
        'This reel is 20 seconds. Reels must be 10 to 15 seconds long.'
      )
      expect(reelLengthProblem(NaN)).equals(
        'This video could not be read. Try another file.'
      )
      expect(reelLengthProblem(Infinity)).equals(
        'This video could not be read. Try another file.'
      )
    })

    it('limits the title to 20 characters, counting an emoji as one', () => {
      expect(titleProblem('a'.repeat(20))).equals(null)
      expect(titleProblem('a'.repeat(21))).equals(
        'Titles can be at most 20 characters.'
      )
      expect(characters('⚾')).equals(1)
      expect(characters('😀')).equals(1)
      expect(titleProblem('😀'.repeat(20))).equals(null)
      expect(titleProblem('😀'.repeat(21))).not.equals(null)
      expect(titleProblem('')).equals('Enter a title.')
      expect(titleProblem('   ')).equals('Enter a title.')
    })

    it('limits the message to 90 characters', () => {
      expect(messageProblem('m'.repeat(90))).equals(null)
      expect(messageProblem('m'.repeat(91))).equals(
        'Messages can be at most 90 characters.'
      )
      expect(messageProblem('')).equals('Enter a message.')
    })

    it('accepts only https addresses with a host', () => {
      expect(urlProblem('https://example.com')).equals(null)
      for (const url of [
        'http://example.com',
        'javascript:alert(1)',
        'https://',
        'example',
        ' https://example.test/promo',
        'HTTPS://example.test',
        'Https://example.test'
      ])
        expect(urlProblem(url), url).equals('Use an https:// address.')
    })

    it('needs a date-time', () => {
      expect(startsAtProblem('2026-12-01T18:00:00.000Z')).equals(null)
      expect(startsAtProblem('')).equals('Choose a date and time.')
      expect(startsAtProblem('soon')).equals('Choose a date and time.')
    })

    it('checks each placement field on its own', () => {
      expect(placementProblems(draft())).deep.equals({})
      expect(
        placementProblems(
          draft({
            logo: null,
            background: gif,
            title: '',
            message: 'm'.repeat(91),
            url: 'http://example.com',
            startsAt: ''
          })
        )
      ).deep.equals({
        logo: 'Choose a logo image.',
        background: 'Images must be JPEG or PNG.',
        title: 'Enter a title.',
        message: 'Messages can be at most 90 characters.',
        url: 'Use an https:// address.',
        startsAt: 'Choose a date and time.'
      })
      expect(placementProblems(draft({ background: null }))).deep.equals({
        background: 'Choose a background image.'
      })
    })

    it('keeps the current images on an edit', () => {
      expect(
        placementProblems(draft({ logo: null, background: null }), true)
      ).deep.equals({})
      expect(
        placementProblems(draft({ logo: gif, background: null }), true)
      ).deep.equals({ logo: 'Images must be JPEG or PNG.' })
    })
  })

  describe('the 24-hour window', () => {
    it('allows edits until 24 hours after placement', () => {
      const placedAt = NOW.toISOString()
      const at = (ms: number): Date => new Date(NOW.getTime() + ms)
      expect(
        canEditPlacement({ placedAt }, at(23 * HOUR + 59 * MINUTE))
      ).equals(true)
      expect(canEditPlacement({ placedAt }, at(24 * HOUR))).equals(false)
    })

    it('seeds 8 of 10 slots left', () => {
      expect(slotsLeft(seed())).equals(8)
    })

    it('returns the slot on a delete inside the window', () => {
      const state = seed()
      const after = placementDeleted(state, 'placement-lakeside-pizza', NOW)
      expect(after.keptSlots).equals(0)
      expect(slotsLeft(after)).equals(9)
    })

    it('keeps the slot used on a delete after the window', () => {
      const state = seed()
      const after = placementDeleted(state, 'placement-summit-dental', NOW)
      expect(after.placements.map(each => each.id)).deep.equals([
        'placement-lakeside-pizza'
      ])
      expect(after.keptSlots).equals(1)
      expect(slotsLeft(after)).equals(8)
      expect(() => placementDeleted(state, 'placement-missing', NOW)).to.throw(
        SponsorRuleError,
        'no longer listed'
      )
    })

    it('refuses an edit outside the window', () => {
      expect(() =>
        checkPlacementEdit(seed(), 'placement-summit-dental', NOW)
      ).to.throw(
        SponsorRuleError,
        'This placement is more than 24 hours old; it can only be deleted.'
      )
      expect(
        checkPlacementEdit(seed(), 'placement-lakeside-pizza', NOW).id
      ).equals('placement-lakeside-pizza')
    })

    it('refuses an add at 0 slots but accepts an edit inside the window', () => {
      const full = placedAgo(2 * HOUR, 9)
      expect(slotsLeft(full)).equals(0)
      expect(() => {
        checkPlacementSlot(full)
      }).to.throw(SponsorRuleError, 'All event stream slots are used.')
      expect(() =>
        checkPlacementEdit(full, full.placements[0].id, NOW)
      ).not.to.throw()
      expect(slotsLeft(full)).equals(0)
      expect(() => {
        checkPlacementSlot(seed())
      }).not.to.throw()
    })
  })
})
