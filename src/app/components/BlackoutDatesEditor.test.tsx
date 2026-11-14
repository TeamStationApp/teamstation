import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { useState } from 'react'

import { rangeDates } from '../../common/venues'
import {
  mount,
  press,
  rowTextColor,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { chooseDateRange, hasLabel, tapText } from '../../test/venueDom'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import {
  BlackoutDatesEditor,
  blackoutRangeLabel,
  BlackoutRangeList
} from './BlackoutDatesEditor'

/** The editor over its own value, recording each change. */
function Editor({
  initial,
  changes,
  today = '2027-03-01'
}: {
  initial: string[]
  changes: string[][]
  today?: string
}): React.ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <BlackoutDatesEditor
      value={value}
      today={today}
      onChange={next => {
        changes.push(next)
        setValue(next)
      }}
    />
  )
}

/** The rows' titles and details, in order. */
function rows(): string[] {
  return [
    ...document.querySelectorAll('[data-testid="relationship-action-row"]')
  ].map(row => (row.textContent ?? '').replace(/Remove$/, ''))
}

describe('the blackout dates editor', () => {
  it('keeps its ranges readable on a dark shared card', async () => {
    await mount(
      <ScopedThemeProvider theme={tsDark}>
        <BlackoutRangeList dates={['2027-07-04']} onRemove={() => undefined} />
      </ScopedThemeProvider>
    )
    expect(rowTextColor('Jul 4')).equals('rgb(31, 36, 24)')
    expect(rowTextColor('Remove')).equals('rgb(186, 26, 26)')
  })
  afterEach(unmount)

  it('reads a range with its day count, and one day alone', () => {
    expect(
      blackoutRangeLabel({ from: '2026-12-20', to: '2027-01-02' })
    ).deep.equals({
      title: 'Dec 20 – Jan 2 · 14 days',
      detail: '2026 – 2027',
      spoken: 'Sunday, December 20, 2026 – Saturday, January 2, 2027'
    })
    expect(
      blackoutRangeLabel({ from: '2027-04-10', to: '2027-04-10' })
    ).deep.equals({
      title: 'Apr 10',
      detail: '2027',
      spoken: 'Saturday, April 10, 2027'
    })
    expect(
      blackoutRangeLabel({ from: '2027-03-10', to: '2027-03-11' }).title
    ).equals('Mar 10 – Mar 11 · 2 days')
  })

  it('says when there are none, and adds a range and a single day', async () => {
    const changes: string[][] = []
    await mount(<Editor initial={[]} changes={changes} />)
    expect(text()).includes('No blackout days.')
    // Cancel adds nothing.
    await press('Add blackout dates')
    await tapText('Cancel')
    expect(changes).deep.equals([])
    await press('Add blackout dates')
    await chooseDateRange('2027-04-02', '2027-04-05')
    // The same day twice is one day.
    await press('Add blackout dates')
    await chooseDateRange('2027-05-29', '2027-05-29')
    expect(changes).deep.equals([
      ['2027-04-02', '2027-04-03', '2027-04-04', '2027-04-05'],
      ['2027-04-02', '2027-04-03', '2027-04-04', '2027-04-05', '2027-05-29']
    ])
    expect(rows()).deep.equals(['Apr 2 – Apr 5 · 4 days2027', 'May 292027'])
    expect(text()).not.includes('No blackout days.')
  })

  it('joins ranges that overlap or touch, and removes a whole range', async () => {
    const changes: string[][] = []
    await mount(
      <Editor
        initial={['2027-04-02', '2027-04-03', '2027-04-10']}
        changes={changes}
      />
    )
    expect(rows()).deep.equals(['Apr 2 – Apr 3 · 2 days2027', 'Apr 102027'])
    // Apr 3 – Apr 5 overlaps the first range; Apr 6 – Apr 9 touches both.
    await press('Add blackout dates')
    await chooseDateRange('2027-04-03', '2027-04-05')
    expect(rows()).deep.equals(['Apr 2 – Apr 5 · 4 days2027', 'Apr 102027'])
    await press('Add blackout dates')
    await chooseDateRange('2027-04-06', '2027-04-09')
    expect(rows()).deep.equals(['Apr 2 – Apr 10 · 9 days2027'])
    expect(changes.at(-1)).deep.equals(rangeDates('2027-04-02', '2027-04-10'))
    // Removing it removes every one of its days.
    await press(
      'Remove blackout Friday, April 2, 2027 – Saturday, April 10, 2027'
    )
    expect(changes.at(-1)).deep.equals([])
    expect(text()).includes('No blackout days.')
  })

  it('removes a single day and leaves the other ranges', async () => {
    const changes: string[][] = []
    await mount(
      <Editor
        initial={['2027-04-02', '2027-04-03', '2027-05-29']}
        changes={changes}
      />
    )
    await press('Remove blackout Saturday, May 29, 2027')
    expect(changes).deep.equals([['2027-04-02', '2027-04-03']])
  })

  it('refuses more than 366 days, and clears the message on the next change', async () => {
    const changes: string[][] = []
    const year = rangeDates('2027-01-01', '2027-12-31')
    await mount(
      <Editor initial={year.slice(1)} changes={changes} today="2026-12-01" />
    )
    // 364 days; Dec 31, 2026 and Jan 1 make 366, and one more would be 367.
    await press('Add blackout dates')
    await chooseDateRange('2026-12-31', '2027-01-01')
    expect(changes.at(-1)).length(366)
    await press('Add blackout dates')
    await chooseDateRange('2026-12-29', '2026-12-29')
    await settle(0)
    expect(text()).includes('Blackouts can cover at most 366 days.')
    expect(changes).length(1)
    // Adding days already there is no more than before, and is allowed.
    await press('Add blackout dates')
    await chooseDateRange('2027-01-01', '2027-01-02')
    expect(text()).not.includes('at most 366')
    expect(changes).length(2)
    await press('Add blackout dates')
    await chooseDateRange('2026-12-29', '2026-12-29')
    expect(text()).includes('at most 366')
    await press(
      'Remove blackout Thursday, December 31, 2026 – Friday, December 31, 2027'
    )
    expect(text()).not.includes('at most 366')
    expect(changes.at(-1)).deep.equals([])
  })

  it('lists ranges to read only, with no remove and no add', async () => {
    await mount(
      <>
        <BlackoutRangeList dates={['2027-07-04', '2027-07-05']} />
        <BlackoutDatesEditor
          value={['2027-07-04']}
          onChange={() => undefined}
          disabled
        />
      </>
    )
    expect(rows()).deep.equals(['Jul 4 – Jul 5 · 2 days2027', 'Jul 42027'])
    expect(hasLabel('Remove blackout Sunday, July 4, 2027')).equals(false)
    expect(hasLabel('Add blackout dates')).equals(false)
  })
})
