import { expect } from 'chai'
import { describe, it } from 'mocha'

import { viewerTimezone } from './eventTime'
import { asTimezoneOption, seasonZone } from './seasonScheduling'

describe('season scheduling', () => {
  it('shows a season at the UTC default in the viewer’s zone, and keeps any other', () => {
    expect(seasonZone({ timezone: 'UTC' }, 'America/Los_Angeles')).equals(
      'America/Los_Angeles'
    )
    expect(
      seasonZone({ timezone: 'America/New_York' }, 'America/Los_Angeles')
    ).equals('America/New_York')
    expect(seasonZone({ timezone: 'UTC' })).equals(viewerTimezone())
  })

  it('reads the zone a save or a build names, if any', () => {
    expect(asTimezoneOption(undefined)).equals(undefined)
    expect(asTimezoneOption(null)).equals(undefined)
    expect(asTimezoneOption('America/Chicago')).equals('America/Chicago')
    for (const bad of [7, '', 'x'.repeat(65)])
      expect(() => asTimezoneOption(bad)).throws('Choose a timezone')
  })
})
