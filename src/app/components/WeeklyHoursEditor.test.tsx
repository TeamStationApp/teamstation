import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { WeekdayHours } from '../../common/venues'
import { mount, press, text, unmount } from '../../test/gameFormDom'
import { hasLabel, tapLabel, tapText } from '../../test/venueDom'
import { BlackoutDatesEditor, dateLabel } from './BlackoutDatesEditor'
import { clockLabel, hoursLabel, WeeklyHoursEditor } from './WeeklyHoursEditor'

describe('the hours and blackout editors', () => {
  afterEach(unmount)

  it('reads times and days plainly', () => {
    expect(clockLabel('00:05')).equals('12:05 AM')
    expect(clockLabel('12:00')).equals('12:00 PM')
    expect(clockLabel('17:30')).equals('5:30 PM')
    expect(clockLabel('24:00')).equals('12:00 AM')
    expect(hoursLabel(undefined)).equals('Closed')
    expect(hoursLabel({ weekday: 1, start: '08:00', end: '18:00' })).equals(
      '8:00 AM – 6:00 PM'
    )
    expect(dateLabel('2027-07-04')).equals('Sunday, July 4, 2027')
  })

  it('closes a day, refuses a closing time before the opening, and cancels without a change', async () => {
    const changes: WeekdayHours[][] = []
    await mount(
      <WeeklyHoursEditor
        value={[
          { weekday: 1, start: '17:00', end: '21:00' },
          { weekday: 6, start: '08:00', end: '24:00' }
        ]}
        onChange={hours => changes.push(hours)}
      />
    )
    expect(text()).includes('8:00 AM – 12:00 AM')
    await press('Hours: Monday, 5:00 PM – 9:00 PM')
    await tapText('Closed')
    await tapText('Done')
    await press('Hours: Saturday, 8:00 AM – 12:00 AM')
    // The picker opens a midnight close at 11:55 PM.
    await tapLabel('Closes 12:00 AM')
    expect(hasLabel('Hour: 11')).equals(true)
    await tapText('Cancel')
    await tapLabel('Opens 8:00 AM')
    await tapLabel('Hour 11')
    await tapLabel('Period PM')
    await tapText('Use time')
    await tapLabel('Closes 12:00 AM')
    await tapLabel('Hour 10')
    await tapLabel('Period AM')
    await tapText('Use time')
    expect(text()).includes('The closing time must be after the opening time.')
    await tapText('Cancel')
    expect(changes).deep.equals([
      [{ weekday: 6, start: '08:00', end: '24:00' }]
    ])
  })

  it('reads only when disabled, and lists blackout days to add and remove', async () => {
    const dates: string[][] = []
    await mount(
      <View2>
        <WeeklyHoursEditor value={[]} onChange={() => undefined} disabled />
        <BlackoutDatesEditor
          value={['2027-07-04']}
          onChange={next => dates.push(next)}
          today="2027-07-01"
        />
        <BlackoutDatesEditor value={[]} onChange={() => undefined} disabled />
      </View2>
    )
    expect(text()).includes('No blackout days.')
    await press('Add blackout day')
    await tapText('Cancel')
    await press('Add blackout day')
    await tapLabel('Choose 2027-07-03')
    await tapText('Use date')
    await press('Remove blackout Sunday, July 4, 2027')
    expect(dates).deep.equals([['2027-07-03', '2027-07-04'], []])
  })
})

function View2({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  return <>{children}</>
}
