// The demo's sample rows. The businesses are invented, and each image is an
// inline SVG tile with the business's initials, so no file is committed.
import type { SponsorState, SponsorTotals } from './sponsorTypes'

export const SPONSOR_TOTALS: SponsorTotals = {
  logoCredits: 300,
  reelCredits: 1000,
  eventSlots: 10
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** A square SVG tile with `initials` on `color`, as a data URL. */
export function initialsTile(initials: string, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">` +
    `<rect width="240" height="240" rx="32" fill="${color}"/>` +
    `<text x="120" y="150" font-family="Helvetica, Arial, sans-serif" font-size="96" ` +
    `font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** A wide SVG banner for an event stream background, as a data URL. */
function bannerTile(from: string, to: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="320" viewBox="0 0 960 320">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs><rect width="960" height="320" fill="url(#g)"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const HARBOR = initialsTile('HH', '#1f5fa8')
const SUMMIT = initialsTile('SD', '#2e8b57')
const LAKESIDE = initialsTile('LP', '#c0392b')
const RIDGEVIEW = initialsTile('RA', '#7d3c98')

/** The seeded state, with placement times relative to `now`. */
export function sponsorSeed(now: Date): SponsorState {
  const at = (offsetMs: number): string =>
    new Date(now.getTime() + offsetMs).toISOString()
  return {
    totals: { ...SPONSOR_TOTALS },
    logos: [
      {
        id: 'logo-harbor-hardware',
        name: 'Harbor Hardware',
        imageUrl: HARBOR,
        version: 1,
        allocation: 100,
        used: 42,
        active: true
      },
      {
        id: 'logo-summit-dental',
        name: 'Summit Dental',
        imageUrl: SUMMIT,
        version: 1,
        allocation: 50,
        used: 0,
        active: true
      },
      {
        id: 'logo-lakeside-pizza',
        name: 'Lakeside Pizza',
        imageUrl: LAKESIDE,
        version: 1,
        allocation: 30,
        used: 30,
        active: false
      }
    ],
    reels: [
      {
        id: 'reel-harbor-hardware',
        name: 'Harbor Hardware',
        videoUrl: '',
        posterUrl: HARBOR,
        durationSec: 12,
        version: 1,
        allocation: 400,
        used: 120,
        active: true
      },
      {
        id: 'reel-ridgeview-auto',
        name: 'Ridgeview Auto',
        videoUrl: '',
        posterUrl: RIDGEVIEW,
        durationSec: 15,
        version: 1,
        allocation: 100,
        used: 0,
        active: true
      }
    ],
    placements: [
      {
        id: 'placement-summit-dental',
        logoUrl: SUMMIT,
        backgroundUrl: bannerTile('#2e8b57', '#a3e4bc'),
        title: 'Summit Dental',
        message: 'Free sports mouthguard fitting for every player this month.',
        url: 'https://summit-dental.example/mouthguards',
        startsAt: at(5 * DAY_MS),
        placedAt: at(-3 * DAY_MS)
      },
      {
        id: 'placement-lakeside-pizza',
        logoUrl: LAKESIDE,
        backgroundUrl: bannerTile('#c0392b', '#f5b7b1'),
        title: 'Lakeside Pizza',
        message: 'Team night: 20% off for families who show their schedule.',
        url: 'https://lakeside-pizza.example/team-night',
        startsAt: at(9 * DAY_MS),
        placedAt: at(-2 * HOUR_MS)
      }
    ],
    keptSlots: 0
  }
}

/** The totals with no rows at all. */
export function emptySponsorState(): SponsorState {
  return {
    totals: { ...SPONSOR_TOTALS },
    logos: [],
    reels: [],
    placements: [],
    keptSlots: 0
  }
}
