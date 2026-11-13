import { mock } from 'node:test'

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
  it('defaults today to the viewer’s local date, not the UTC one', async () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    // 9 PM on March 1 in Los Angeles is already March 2 in UTC.
    mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2027-03-02T05:00:00Z')
    })
    try {
      const changes: WindowPeriod[][] = []
      await mount(
        <TimeWindowsEditor value={[]} onChange={next => changes.push(next)} />
      )
      await tapText('Add another time window')
      expect(changes).deep.equals([[{ from: '2027-03-01', hours: [] }]])
    } finally {
      mock.timers.reset()
      if (zone == null) delete process.env.TZ
      else process.env.TZ = zone
    }
  })
  it('gives every window an end date when the windows require one', async () => {
    let saved: WindowPeriod[] = []
    function Editor(): React.ReactElement {
      const [value, setValue] = useState<WindowPeriod[]>([])
      return (
        <TimeWindowsEditor
          value={value}
          today="2027-03-01"
          endDate="2027-06-30"
          requireEnd
          onChange={next => {
            saved = next
            setValue(next)
          }}
        />
      )
    }
    await mount(<Editor />)
    await tapText('Add another time window')
    expect(saved).deep.equals([
      { from: '2027-03-01', until: '2027-06-30', hours: [] }
    ])
    await tapText('Add another time window')
    await chooseCalendarDate('2027-05-01')
    expect(saved.map(period => [period.from, period.until])).deep.equals([
      ['2027-03-01', '2027-04-30'],
      ['2027-05-01', '2027-06-30']
    ])
    await tapLabel('Change the end of Time Windows from Saturday, May 1, 2027')
    expect(text()).not.includes('No end date')
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
