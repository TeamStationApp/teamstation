import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { scheduleDate } from '../screens/format'
import { ThemeProvider } from '../theme/ThemeContext'
import { ScheduleRow } from './ScheduleRow'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

const START = '2026-10-04T23:45:00.000Z'

function row(
  patch: Partial<React.ComponentProps<typeof ScheduleRow>> = {}
): React.ReactElement {
  return (
    <ScheduleRow
      first="Badgers"
      second="@ Sox"
      startAt={START}
      venue="Field 2"
      status="final"
      awayScore={4}
      homeScore={0}
      videoCount={1}
      onPress={() => undefined}
      {...patch}
    />
  )
}

function text(container: HTMLElement): string {
  return container.textContent ?? ''
}

describe('ScheduleRow', function () {
  it('shows the month, the day, and the weekday and time, with no picture', async function () {
    const container = await render(row())
    const dated = scheduleDate(START)
    expect(container.querySelector('img')).equals(null)
    expect(text(container)).includes(dated.month)
    expect(text(container)).includes(dated.day)
    expect(text(container)).includes(dated.when)
    expect(text(container)).includes('4–0')
    expect(container.querySelector('[aria-label="Video"]')).not.equals(null)
  })

  it('says LIVE instead of the score while the game is being scored', async function () {
    const container = await render(
      row({ status: 'inProgress', awayScore: 2, homeScore: 1 })
    )
    expect(text(container)).includes('LIVE')
    expect(text(container)).not.includes('2–1')
  })

  it('does not say LIVE just because a camera is publishing', async function () {
    const container = await render(
      row({
        status: 'scheduled',
        isLive: true,
        awayScore: null,
        homeScore: null,
        videoCount: 0
      })
    )
    expect(text(container)).not.includes('LIVE')
    expect(container.querySelector('[aria-label="Video"]')).equals(null)
  })

  it('draws an em dash when the date is missing', async function () {
    const container = await render(row({ startAt: null, videoCount: 0 }))
    expect(text(container)).includes('\u2014')
    expect(container.querySelector('[aria-label="Video"]')).equals(null)
  })

  it('draws one team line when there is no second, and says only that', async function () {
    const container = await render(row({ first: '@ Owls', second: undefined }))
    const dated = scheduleDate(START)
    const lines = [...container.querySelectorAll('div')]
      .filter(node => node.childElementCount === 0)
      .map(node => node.textContent)
    expect(lines).includes('@ Owls')
    expect(lines).not.includes('Badgers')
    expect(text(container)).includes('4–0')
    expect(
      container.querySelector('[role="button"]')?.getAttribute('aria-label')
    ).equals(`@ Owls, ${dated.when}`)
  })

  it('names both teams in its label when it has two lines', async function () {
    const container = await render(row())
    const dated = scheduleDate(START)
    expect(
      container.querySelector('[role="button"]')?.getAttribute('aria-label')
    ).equals(`Badgers @ Sox, ${dated.when}`)
  })

  it('shows a result written from one side in place of the away–home score', async function () {
    const container = await render(
      row({
        first: 'vs Hawks',
        second: undefined,
        result: { label: 'W 5\u20132', tone: 'win' }
      })
    )
    expect(text(container)).includes('W 5\u20132')
    expect(text(container)).not.includes('4\u20130')
  })

  it('still says LIVE over a result while the game is being scored', async function () {
    const container = await render(
      row({
        status: 'inProgress',
        result: { label: 'W 5\u20132', tone: 'win' }
      })
    )
    expect(text(container)).includes('LIVE')
    expect(text(container)).not.includes('W 5')
  })
})
