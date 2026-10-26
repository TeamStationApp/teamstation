import { expect } from 'chai'
import { act } from 'react'

import type { VenueDetail, VenueField } from '../common/venues'
import { pressSchedule, typeSchedule } from './eventScheduleDom'
import { settle } from './gameFormDom'

/** A venue detail for the venue and field screens' tests. */
export function venueDetail(overrides: Partial<VenueDetail> = {}): VenueDetail {
  return {
    id: 'ven_demo',
    placeId: 'example-park',
    name: 'Example Park',
    address: '1 Example Way, Demo City',
    timezone: 'America/New_York',
    sizeSwitchMinutes: 0,
    defaultHours: [{ weekday: 6, start: '08:00', end: '18:00' }],
    defaultBlackouts: [],
    photoUrl: null,
    photoLargeUrl: null,
    owners: [],
    claims: [],
    fields: [],
    rights: {
      canEdit: false,
      claimLeagues: [],
      canClaim: false,
      canRequest: false,
      claimBlocked: null,
      leaveClaimIds: [],
      canRemoveOwners: false,
      decidableClaimIds: []
    },
    map: {
      latitude: 40.02,
      longitude: -75.22,
      googleMapsApiKey: undefined
    },
    ...overrides
  }
}

/**
 * The settings the screen's web pin map was drawn with, read back from its
 * framed document, and whether that document holds any tiles but Google's.
 */
export function pinMapDrawn(): {
  config: Record<string, unknown>
  foreignTiles: boolean
} {
  const html =
    document
      .querySelector('iframe[data-testid="pin-map"]')
      ?.getAttribute('srcdoc') ?? ''
  const config = /const config=(\{.*?\});/.exec(html)
  expect(config, 'the pin map document').not.equals(null)
  return {
    config: JSON.parse(config![1]) as Record<string, unknown>,
    foreignTiles: /leaflet|openstreetmap|tileUrl/i.test(html)
  }
}

export function venueField(overrides: Partial<VenueField> = {}): VenueField {
  return {
    id: 'fld_one',
    name: 'Field 1',
    sizes: ['46/60', '50/70'],
    pin: null,
    startsOn: null,
    endsOn: null,
    hours: null,
    blackouts: [],
    photoUrl: null,
    photoLargeUrl: null,
    ...overrides
  }
}

/** Every element with an accessible label, and its label. */
function labelled(): Array<[HTMLElement, string]> {
  return [...document.querySelectorAll<HTMLElement>('[aria-label]')].map(
    node => [node, node.getAttribute('aria-label') ?? '']
  )
}

/** Clicks the element labelled exactly so, whatever its role. */
export async function tapLabel(label: string): Promise<void> {
  const found = labelled().find(([, name]) => name === label)
  expect(
    found,
    `${label} among ${labelled()
      .map(([, n]) => n)
      .join(' | ')}`
  ).not.equals(undefined)
  await act(async () => {
    found![0].click()
  })
  await settle(0)
}

/** Whether an element labelled exactly so is on the page. */
export function hasLabel(label: string): boolean {
  return labelled().some(([, name]) => name === label)
}

/**
 * Clicks the last button or tab whose visible text is exactly this: the one
 * in a sheet that slid up, over the row that opened it.
 */
export async function tapText(text: string): Promise<void> {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ]
    .reverse()
    .find(node => node.textContent === text)
  expect(found, text).not.equals(undefined)
  await act(async () => {
    found!.click()
  })
  await settle(0)
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** Picks a date in an open calendar picker and uses it. */
export async function chooseCalendarDate(date: string): Promise<void> {
  await typeSchedule('Year', date.slice(0, 4))
  await pressSchedule('[aria-label^="Choose month:"]')
  await pressSchedule(MONTHS[Number(date.slice(5, 7)) - 1])
  await pressSchedule(`Choose ${date}`)
  await pressSchedule('Use date')
  await settle(0)
}

/**
 * Picks a range in an open two-tap range calendar, `from` then `to`, moving
 * month by month to each, and uses it. The same day twice is one day.
 */
export async function chooseDateRange(from: string, to: string): Promise<void> {
  for (const day of [from, to]) {
    for (let month = 0; month < 36 && !hasLabel(day); month++) {
      const shown = [
        ...document.querySelectorAll<HTMLElement>('[aria-label^="20"]')
      ]
        .map(node => node.getAttribute('aria-label') ?? '')
        .find(label => /^\d{4}-\d{2}-\d{2}$/.test(label))
      await tapLabel(
        shown != null && shown > day ? 'Previous month' : 'Next month'
      )
    }
    await tapLabel(day)
  }
  await tapText('Use this range')
  await settle(0)
}
