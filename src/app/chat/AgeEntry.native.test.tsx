import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { couldBeAged } from '../../common/age'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { AgeEntry, birthYears, startingBirth } from './AgeEntry.native'
import type { AppleAge } from './declaredAge'

let root: Root | undefined
const delay = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

// Midday on 12 April 2027, local time: the same month and year in UTC
// wherever the tests run.
const TODAY = new Date(2027, 3, 12, 12)
const TEEN: AppleAge = { kind: 'minor', lowerBound: 13, upperBound: 15 }
const OLDER_TEEN: AppleAge = { kind: 'minor', lowerBound: 16, upperBound: 17 }

async function draw(apple: AppleAge): Promise<{
  saved: Array<{ year: number; month: number }>
  backs: number[]
}> {
  const saved: Array<{ year: number; month: number }> = []
  const backs: number[] = []
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <AgeEntry
          apple={apple}
          busy={false}
          today={TODAY}
          onSave={birth => saved.push(birth)}
          onBack={() => backs.push(1)}
        />
      </ThemeProvider>
    )
    await delay()
  })
  return { saved, backs }
}

const byId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const tap = async (id: string): Promise<void> => {
  await act(async () => {
    byId(id).click()
    await delay()
  })
}
const chosen = (): string | null => byId('chat-age-chosen').textContent
const saveOn = (): boolean =>
  byId('chat-age-save').getAttribute('aria-disabled') !== 'true'
const rows = (wheel: string): number[] =>
  [...document.querySelectorAll(`[data-testid^="${wheel}-"]`)].map(node =>
    Number(node.getAttribute('data-testid')!.slice(wheel.length + 1))
  )

describe('the native age entry', function () {
  it('starts 10 years ago, this local month, and saves what the wheels are turned to', async function () {
    expect(startingBirth('none', TODAY)).deep.equals({ year: 2017, month: 4 })
    const { saved, backs } = await draw('none')
    expect(chosen()).equals('April 2017')
    expect(rows('chat-age-year')[0]).equals(1900)
    expect(rows('chat-age-year').at(-1)).equals(2027)
    expect(rows('chat-age-month')).deep.equals([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    ])
    expect(byId('chat-age-year-2017')).not.equals(null)
    // Not an answer until a wheel is turned: an untouched Save saves nothing.
    expect(saveOn()).equals(false)
    await tap('chat-age-save')
    expect(saved).deep.equals([])
    await tap('chat-age-year-1990')
    await tap('chat-age-month-11')
    expect(chosen()).equals('November 1990')
    await tap('chat-age-save')
    expect(saved).deep.equals([{ year: 1990, month: 11 }])
    await tap('chat-age-back')
    expect(backs).deep.equals([1])
  })

  it('refuses a month in the future', async function () {
    const { saved } = await draw('none')
    await tap('chat-age-year-2027')
    await tap('chat-age-month-5')
    expect(saveOn()).equals(false)
    expect(document.body.textContent).contains(lstrings.chat_age_invalid)
    await tap('chat-age-save')
    expect(saved).deep.equals([])
    await tap('chat-age-month-4')
    expect(saveOn()).equals(true)
  })

  it('offers only the years Apple’s range allows, and starts inside it', async function () {
    for (const apple of [TEEN, OLDER_TEEN] as const) {
      const years = birthYears(apple, TODAY)
      expect(years.length).greaterThan(0)
      for (const year of years) {
        expect(
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].some(month =>
            couldBeAged(year, month, TODAY, apple.lowerBound, apple.upperBound)
          ),
          String(year)
        ).equals(true)
      }
      const start = startingBirth(apple, TODAY)
      expect(
        couldBeAged(
          start.year,
          start.month,
          TODAY,
          apple.lowerBound,
          apple.upperBound
        )
      ).equals(true)
    }
    // 13 to 15 on 12 April 2027: born from April 2011 to April 2014 (in the
    // month of birth either age is possible).
    expect(birthYears(TEEN, TODAY)).deep.equals([2011, 2012, 2013, 2014])
    // April 2014 could be 13 today, but the server takes a birth month as
    // not yet come (`ageOn`: 12), so the start is March 2014, a 13-year-old.
    expect(startingBirth(TEEN, TODAY)).deep.equals({ year: 2014, month: 3 })
    // 16 to 17: in 2011, April is in range but 15 by `ageOn`; March is 16.
    expect(startingBirth(OLDER_TEEN, TODAY)).deep.equals({
      year: 2011,
      month: 3
    })
    expect(birthYears(OLDER_TEEN, TODAY)).deep.equals([2009, 2010, 2011])
    // Given the year wheel's years, it starts among them.
    expect(startingBirth(TEEN, TODAY, [2012, 2013])).deep.equals({
      year: 2013,
      month: 4
    })
  })

  it('takes either wheel turned as an answer, the month too', async function () {
    const { saved } = await draw('none')
    expect(saveOn()).equals(false)
    // A tap on the rows already shown changes nothing, and answers nothing.
    await tap('chat-age-year-2017')
    await tap('chat-age-month-4')
    expect(saveOn()).equals(false)
    await tap('chat-age-month-3')
    expect(saveOn()).equals(true)
    await tap('chat-age-save')
    expect(saved).deep.equals([{ year: 2017, month: 3 }])
  })

  it('refuses a month outside Apple’s range in a year it offers', async function () {
    const { saved } = await draw(TEEN)
    expect(rows('chat-age-year')).deep.equals([2011, 2012, 2013, 2014])
    expect(chosen()).equals('March 2014')
    // Inside Apple's range the start is an answer the server ages 13.
    expect(saveOn()).equals(true)
    await tap('chat-age-month-12')
    expect(saveOn()).equals(false)
    await tap('chat-age-year-2012')
    expect(saveOn()).equals(true)
    await tap('chat-age-save')
    expect(saved).deep.equals([{ year: 2012, month: 12 }])
  })

  it('offers every year to an Apple adult or an unanswered phone', async function () {
    for (const apple of [
      'pending',
      'declined',
      { kind: 'adult', lowerBound: 18 }
    ] as const) {
      expect(birthYears(apple, TODAY)).has.length(2027 - 1900 + 1)
    }
  })
})
