import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import { formatDateRange } from '../../common/seasonTimeFrames'
import { ThemeProvider } from '../theme/ThemeContext'
import { SeasonTimeFrameScreen, timeFrameYears } from './SeasonTimeFrameScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''
function byLabel(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}
const saveButton = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.textContent === 'Save'
  )
async function press(label: string): Promise<void> {
  const node =
    byLabel(label) ??
    [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      one => one.textContent === label
    )
  expect(node, label).not.equals(undefined)
  expect(node, label).not.equals(null)
  await act(async () => {
    node!.click()
    await delay(10)
  })
}
const selected = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')]
    .filter(node => node.getAttribute('aria-selected') === 'true')
    .map(node => String(node.getAttribute('aria-label')))

interface Fake {
  client: TeamStationClient
  saved: unknown[]
  fail: { save: boolean }
}
function fake(dates: { startsOn: string | null; endsOn: string | null }): Fake {
  const saved: unknown[] = []
  const fail = { save: false }
  const client = {
    group: async () => ({ group: { id: 'sea1', kind: 'season', ...dates } }),
    updateGroup: async (ref: unknown, fields: unknown) => {
      if (fail.save) throw new Error('The season could not be saved')
      saved.push([ref, fields])
      return {}
    }
  } as unknown as TeamStationClient
  return { client, saved, fail }
}
async function mount(f: Fake, onSaved = (): void => undefined): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <SeasonTimeFrameScreen
          client={f.client}
          id="sea1"
          onSaved={onSaved}
          now={() => new Date(2026, 9, 27)}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
}

describe('a season’s date range', function () {
  it('opens on this year with no season chosen, and saves nothing until there is a range', async function () {
    const f = fake({ startsOn: null, endsOn: null })
    await mount(f)
    expect(text()).includes('Set date range')
    expect(byLabel('Year 2026')).not.equals(null)
    // A year at the top, then Winter and Spring, then Summer and Fall.
    expect(
      [...document.querySelectorAll('[role="tab"]')].map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals(['Winter 2026', 'Spring 2026', 'Summer 2026', 'Fall 2026'])
    const order = text()
    expect(order.indexOf('2026')).lessThan(order.indexOf('Winter'))
    expect(order.indexOf('Fall')).lessThan(order.indexOf('Custom'))
    expect(order.indexOf('Custom')).lessThan(order.indexOf('Save'))
    expect(selected()).deep.equals([])
    expect(saveButton()?.getAttribute('aria-disabled')).equals('true')
    await press('Save')
    expect(f.saved).deep.equals([])
  })

  it('opens on a stored season, saves another and goes back', async function () {
    const f = fake({ startsOn: '2025-03-01', endsOn: '2025-05-31' })
    let saved = 0
    await mount(f, () => {
      saved++
    })
    expect(byLabel('Year 2025')).not.equals(null)
    expect(selected()).deep.equals(['Spring 2025'])
    await press('Summer 2025')
    expect(selected()).deep.equals(['Summer 2025'])
    await press('Save')
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        { label: 'Summer 2025', startsOn: '2025-06-01', endsOn: '2025-08-31' }
      ]
    ])
    expect(saved).equals(1)
  })

  it('moves a chosen season to the year picked on the wheel', async function () {
    // Fifty years either side of the years in play, inside 1900–9999.
    expect(timeFrameYears(2025, 2026)[0]).equals(1975)
    expect(timeFrameYears(2025, 2026).at(-1)).equals(2076)
    expect(timeFrameYears(1910, 2026)[0]).equals(1900)
    expect(timeFrameYears(9990, 2026).at(-1)).equals(9999)
    const f = fake({ startsOn: '2025-03-01', endsOn: '2025-05-31' })
    await mount(f)
    await press('Year 2025')
    expect(byLabel('Year: 2025')).not.equals(null)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="time-frame-year-2027"]')!
        .click()
      await delay(10)
    })
    await press('Done')
    expect(byLabel('Year 2027')).not.equals(null)
    expect(selected()).deep.equals(['Spring 2027'])
    await press('Save')
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        { label: 'Spring 2027', startsOn: '2027-03-01', endsOn: '2027-05-31' }
      ]
    ])
  })

  it('takes Custom dates, which leave every season unchosen', async function () {
    const f = fake({ startsOn: '2026-03-01', endsOn: '2026-05-31' })
    await mount(f)
    await press('Custom')
    expect(text()).includes('Use this range')
    await press('2026-03-05')
    await press('2026-03-20')
    await press('Use this range')
    // The picker stays open, and the range matches no season. Custom reads
    // the dates as season settings writes them.
    expect(text()).includes('Use this range')
    expect(selected()).deep.equals([])
    expect(
      byLabel(`Custom, ${formatDateRange('2026-03-05', '2026-03-20')}`)
    ).not.equals(null)
    expect(text()).not.includes('2026-03-05 – 2026-03-20')
    await press('Save')
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        { startsOn: '2026-03-05', endsOn: '2026-03-20' }
      ]
    ])
    await press('Cancel')
    expect(text()).not.includes('Use this range')
  })

  it('reads a Custom range that is a season of the year shown as that season', async function () {
    // A non-season range anchors the calendar in March regardless of today's
    // month. The screen's injected clock controls only its year selector.
    const f = fake({ startsOn: '2026-03-02', endsOn: '2026-05-30' })
    await mount(f)
    expect(selected()).deep.equals([])
    await press(`Custom, ${formatDateRange('2026-03-02', '2026-05-30')}`)
    await press('2026-03-01')
    await press('Next month')
    await press('Next month')
    await press('2026-05-31')
    await press('Use this range')
    expect(selected()).deep.equals(['Spring 2026'])
  })

  it('keeps a season chosen before the stored range arrives', async function () {
    const f = fake({ startsOn: '2025-03-01', endsOn: '2025-05-31' })
    let arrive: () => void = () => undefined
    const group = f.client.group.bind(f.client)
    f.client.group = async (ref: never) => {
      await new Promise<void>(resolve => {
        arrive = resolve
      })
      return await group(ref)
    }
    await mount(f)
    await press('Fall 2026')
    await act(async () => {
      arrive()
      await delay(20)
    })
    // The late read puts back neither the year nor the season.
    expect(selected()).deep.equals(['Fall 2026'])
    await press('Save')
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        { label: 'Fall 2026', startsOn: '2026-09-01', endsOn: '2026-11-30' }
      ]
    ])
  })

  it('shows a season chosen while Custom is open in its date picker', async function () {
    const f = fake({ startsOn: null, endsOn: null })
    await mount(f)
    await press('Custom')
    await press('Spring 2026')
    // The picker opened again on Spring's dates: Use this range keeps them.
    await press('Use this range')
    expect(selected()).deep.equals(['Spring 2026'])
    await press('Save')
    expect(f.saved).deep.equals([
      [
        { kind: 'season', id: 'sea1' },
        { startsOn: '2026-03-01', endsOn: '2026-05-31' }
      ]
    ])
  })

  it('stays with the reason when the save fails, and writes nothing on leaving', async function () {
    const f = fake({ startsOn: '2026-03-01', endsOn: '2026-05-31' })
    f.fail.save = true
    let saved = 0
    await mount(f, () => {
      saved++
    })
    await press('Fall 2026')
    await press('Save')
    expect(text()).includes('The season could not be saved')
    expect(saved).equals(0)
    expect(saveButton()?.getAttribute('aria-disabled')).not.equals('true')
    await act(async () => root?.unmount())
    root = undefined
    expect(f.saved).deep.equals([])
  })
})
