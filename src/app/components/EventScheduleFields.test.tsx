import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import {
  type EventScheduleDraft,
  eventScheduleValue,
  newEventSchedule
} from '../../common/eventSchedule'
import {
  chooseSchedule,
  pressSchedule,
  typeSchedule
} from '../../test/eventScheduleDom'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  EventScheduleFields,
  offsetFromWallClock,
  zoneDetail
} from './EventScheduleFields'

let root: Root | undefined
let draft: EventScheduleDraft
function Harness(): React.ReactElement {
  const [value, setValue] = useState(() =>
    newEventSchedule('2027-04-10T23:30:00Z', null, 'UTC', 'US/Pacific')
  )
  draft = value
  return <EventScheduleFields value={value} onChange={setValue} />
}
async function render(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
  })
}

describe('shared calendar, five-minute wheels and timezone autocomplete', () => {
  for (const picker of ['time', 'endTime'] as const)
    it(`reconfirms an off-grid second-fold ${picker} at the nearest five minutes`, async () => {
      function OffGridHarness(): React.ReactElement {
        const [value, setValue] = useState(() =>
          newEventSchedule(
            picker === 'time' ? '2027-11-07T09:32:00Z' : '2027-11-07T08:45:00Z',
            picker === 'time' ? '2027-11-07T12:32:00Z' : '2027-11-07T09:32:00Z',
            'America/Los_Angeles'
          )
        )
        draft = value
        return <EventScheduleFields value={value} onChange={setValue} />
      }
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <OffGridHarness />
          </ThemeProvider>
        )
      })
      await pressSchedule(`[data-testid="event-schedule-${picker}"]`)
      await pressSchedule('Use time')
      const saved = eventScheduleValue(draft)
      expect(picker === 'time' ? saved.startAt : saved.endAt).equals(
        '2027-11-07T09:30:00.000Z'
      )
    })
  for (const picker of ['time', 'endTime'] as const)
    it(`advances the calendar date when reconfirming a near-midnight ${picker}`, async () => {
      function MidnightHarness(): React.ReactElement {
        const [value, setValue] = useState(() =>
          newEventSchedule(
            picker === 'time' ? '2027-04-10T23:58:00Z' : '2027-04-10T20:00:00Z',
            picker === 'time' ? null : '2027-04-10T23:58:00Z',
            'UTC'
          )
        )
        draft = value
        return <EventScheduleFields value={value} onChange={setValue} />
      }
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <MidnightHarness />
          </ThemeProvider>
        )
      })
      await pressSchedule(`[data-testid="event-schedule-${picker}"]`)
      expect(document.body.textContent).includes('Next day')
      await pressSchedule('Use time')
      const saved = eventScheduleValue(draft)
      expect(picker === 'time' ? saved.startAt : saved.endAt).equals(
        '2027-04-11T00:00:00.000Z'
      )
    })
  it('preserves the loaded day and offset when a repeated end clock precedes its start', async () => {
    function SavedFoldHarness(): React.ReactElement {
      const [value, setValue] = useState(() =>
        newEventSchedule(
          '2027-11-07T08:45:00Z',
          '2027-11-07T09:30:00Z',
          'America/Los_Angeles'
        )
      )
      draft = value
      return <EventScheduleFields value={value} onChange={setValue} />
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SavedFoldHarness />
        </ThemeProvider>
      )
    })
    await pressSchedule('[data-testid="event-schedule-endTime"]')
    await pressSchedule('Use time')
    expect(eventScheduleValue(draft).endAt).equals('2027-11-07T09:30:00.000Z')
  })
  it('reconfirms an inferred repeated-hour end without changing its offset', async () => {
    function FoldHarness(): React.ReactElement {
      const [value, setValue] = useState(() =>
        newEventSchedule('2027-11-07T06:30:00Z', null, 'America/Los_Angeles')
      )
      draft = value
      return <EventScheduleFields value={value} onChange={setValue} />
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <FoldHarness />
        </ThemeProvider>
      )
    })
    await pressSchedule('Set end time')
    await pressSchedule('[data-testid="event-schedule-endTime"]')
    await pressSchedule('Use time')
    expect(eventScheduleValue(draft).endAt).equals('2027-11-07T09:30:00.000Z')
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  it('selects distant leap dates and a five-minute time with an automatically advanced end', async () => {
    await render()
    await chooseSchedule('Date', '2032-02-29')
    await chooseSchedule('Start time', '23:45')
    await pressSchedule('Set end time')
    expect(draft).includes({
      date: '2032-02-29',
      time: '23:45',
      endDate: '2032-03-01',
      endTime: '02:45'
    })
    expect(eventScheduleValue(draft).endAt).equals('2032-03-01T02:45:00.000Z')
    await pressSchedule('Set end date')
    await chooseSchedule('End date', '2032-03-02')
    await chooseSchedule('End time', '01:05')
    expect(eventScheduleValue(draft).endAt).equals('2032-03-02T01:05:00.000Z')
    await pressSchedule('Remove end date')
    expect(draft.endDate).equals('2032-03-01')
    await pressSchedule('Remove end time')
    expect(eventScheduleValue(draft).endAt).equals(null)
  })
  it('cancels calendar/time choices and prevents invalid years without losing the draft', async () => {
    await render()
    await pressSchedule('[data-testid="event-schedule-date"]')
    await pressSchedule('Next month')
    await pressSchedule('Previous month')
    await typeSchedule('Year', 'bad')
    expect(document.body.textContent).includes('Enter a year')
    await pressSchedule('Cancel date picker')
    await pressSchedule('[data-testid="event-schedule-time"]')
    await pressSchedule('Hour 01')
    await pressSchedule('Minute 05')
    await pressSchedule('Period AM')
    await pressSchedule('Cancel time picker')
    expect(draft).includes({ date: '2027-04-10', time: '23:30' })
  })
  it('searches timezones and commits only a complete selection', async () => {
    await render()
    await pressSchedule('[data-testid="event-schedule-timezone"]')
    await typeSchedule('Find time zone', 'not a zone')
    expect(document.body.textContent).includes(
      'No matching cities or time zones'
    )
    expect(draft.timezone).equals('UTC')
    await pressSchedule('Cancel time zone picker')
    await chooseSchedule('Time zone', 'America/Los_Angeles')
    expect(draft.timezone).equals('America/Los_Angeles')
    await chooseSchedule('Time zone', 'US/Pacific')
    expect(draft.timezone).equals('US/Pacific')
  })
  it('lists time zones as rows with their offset, marks the chosen one and cancels in red text', async () => {
    await render()
    await pressSchedule('[data-testid="event-schedule-timezone"]')
    await typeSchedule('Find time zone', 'Los Angeles')
    const row = document.querySelector<HTMLElement>(
      '[aria-label="Use time zone America/Los_Angeles"]'
    )!
    expect(row.textContent).match(/America\/Los Angeles.*GMT-[78] · .* now/)
    // A row, never a pill: no button shell, and the chosen zone is marked.
    expect(getComputedStyle(row).borderRadius).not.equals('24px')
    await typeSchedule('Find time zone', 'UTC')
    const chosen = document.querySelector<HTMLElement>(
      '[aria-label="Use time zone UTC"]'
    )!
    expect(chosen.getAttribute('aria-selected')).equals('true')
    const cancel = document.querySelector<HTMLElement>(
      '[aria-label="Cancel time zone picker"]'
    )!
    expect(cancel.textContent).equals('Cancel')
    const label = [...cancel.querySelectorAll('div')].find(
      node => node.textContent === 'Cancel'
    )!
    expect(getComputedStyle(label).color).equals('rgb(186, 26, 26)')
    await pressSchedule('Cancel time zone picker')
    expect(draft.timezone).equals('UTC')
    expect(zoneDetail('Not/AZone')).equals('')
    // Where the engine cannot name an offset, the wall clock gives it.
    const wall = (zone: string): Intl.DateTimeFormat =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    const summer = new Date('2027-07-01T12:00:00Z')
    expect(offsetFromWallClock(wall('America/Los_Angeles'), summer)).equals(
      'GMT-7'
    )
    expect(offsetFromWallClock(wall('Asia/Kolkata'), summer)).equals('GMT+5:30')
    expect(offsetFromWallClock(wall('UTC'), summer)).equals('GMT')
    expect(zoneDetail('Asia/Kolkata', summer)).equals('GMT+5:30 · 5:30 PM now')
    expect(zoneDetail('UTC', new Date('2027-04-10T23:30:00Z'))).equals(
      'GMT+0 · 11:30 PM now'
    )
  })
  it('chooses a month from a grid of plain cells', async () => {
    await render()
    await pressSchedule('[data-testid="event-schedule-date"]')
    await pressSchedule('[aria-label^="Choose month:"]')
    const april = document.querySelector<HTMLElement>('[aria-label="April"]')!
    expect(april.getAttribute('aria-selected')).equals('true')
    expect(april.textContent).equals('Apr')
    await pressSchedule('June')
    expect(
      document.querySelector('[aria-label^="Choose month:"]')?.textContent
    ).equals('June')
    await pressSchedule('Cancel date picker')
  })
  it('snaps a scrolled minute wheel to five-minute values', async () => {
    await render()
    await pressSchedule('[data-testid="event-schedule-time"]')
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="event-time-hour-wheel"]'
      )?.scrollTop
    ).equals(440)
    const wheel = document.querySelector<HTMLElement>(
      '[data-testid="event-time-minute-wheel"]'
    )!
    await act(async () => {
      wheel.scrollTop = 88
      wheel.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 250))
    })
    await pressSchedule('Use time')
    expect(draft.time).equals('23:10')
  })
  it('positions a delayed content layout at the saved time once and preserves subsequent scrolling', async () => {
    const platform = Platform as { OS: string }
    const previous = platform.OS
    platform.OS = 'android'
    try {
      await render()
      await pressSchedule('[data-testid="event-schedule-time"]')
      const wheel = document.querySelector<HTMLElement>(
        '[data-testid="event-time-minute-wheel"]'
      )!
      const content = wheel.firstElementChild as HTMLElement & {
        __reactLayoutHandler: (event: {
          nativeEvent: { layout: { width: number; height: number } }
        }) => void
      }
      const layout = (): void => {
        content.__reactLayoutHandler({
          nativeEvent: { layout: { width: 100, height: 616 } }
        })
      }
      await act(async () => {
        wheel.scrollTop = 0
        layout()
      })
      expect(wheel.scrollTop).equals(264)
      await act(async () => {
        wheel.scrollTop = 88
        layout()
      })
      expect(wheel.scrollTop).equals(88)
    } finally {
      platform.OS = previous
    }
  })
})
