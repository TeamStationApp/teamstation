import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { useState } from 'react'

import { periodOn } from '../../common/fieldAvailability'
import { weeklyWindow, type WindowPeriod } from '../../common/windowPeriods'
import { mount, text, unmount } from '../../test/gameFormDom'
import {
  chooseCalendarDate,
  hasLabel,
  tapLabel,
  tapText
} from '../../test/venueDom'
import { TimeWindowsEditor } from './TimeWindowsEditor'

const hours = [{ weekday: 6, start: '08:00', end: '18:00' }]
describe('dated time window editing', () => {
  afterEach(unmount)
  it('preserves legacy availability while adding a dated boundary and uses a supported picker year', async () => {
    let saved = weeklyWindow(hours)
    function Editor(): React.ReactElement {
      const [value, setValue] = useState(saved)
      return (
        <TimeWindowsEditor
          value={value}
          today="2027-03-01"
          onChange={next => {
            saved = next
            setValue(next)
          }}
        />
      )
    }
    await mount(<Editor />)
    expect(text()).includes('Existing hours')
    expect(text()).not.includes('0001')
    await tapLabel('Change the start of Time Windows from Existing hours')
    expect(hasLabel('Choose 2027-03-01')).equals(true)
    await tapText('Cancel')
    await tapText('Add another time window')
    expect(hasLabel('Choose 2027-03-01')).equals(true)
    await chooseCalendarDate('2027-04-01')
    expect(saved.map(period => period.from)).deep.equals([
      '0001-01-01',
      '2027-04-01'
    ])
    expect(periodOn(saved, '2027-03-20')?.hours).deep.equals(hours)
    await tapLabel('Remove Time Windows from Thursday, April 1, 2027')
    expect(saved).deep.equals(weeklyWindow(hours))
  })
  it('starts a closed editor at today and prevents changes to inherited windows', async () => {
    const changes: WindowPeriod[][] = []
    await mount(
      <TimeWindowsEditor
        value={[]}
        today="2027-03-01"
        onChange={next => changes.push(next)}
      />
    )
    await tapText('Add another time window')
    expect(changes).deep.equals([[{ from: '2027-03-01', hours: [] }]])
    await unmount()
    await mount(
      <TimeWindowsEditor
        value={weeklyWindow(hours)}
        disabled
        today="2027-03-01"
        onChange={next => changes.push(next)}
      />
    )
    expect(
      hasLabel('Change the start of Time Windows from Existing hours')
    ).equals(false)
    await tapLabel('Remove Time Windows from Existing hours')
    expect(changes).length(1)
  })
})
