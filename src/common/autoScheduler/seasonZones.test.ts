import { expect } from 'chai'
import { describe, it } from 'mocha'

import { field, season } from './fixtures.test'
import { seasonZones } from './seasonZones'

describe('season timezone fallback', () => {
  it('selects compatible season fields in run order and deduplicates zones', () => {
    const east = field({ id: 'east' })
    const west = field({
      id: 'west',
      availability: { ...east.availability, timezone: 'America/Los_Angeles' }
    })
    expect(
      seasonZones(
        [east, west, { ...west, id: 'west2' }],
        season({ fieldIds: ['west2', 'west'] }).settings
      )
    ).deep.equals(['America/Los_Angeles'])
    expect(
      seasonZones(
        [east, west],
        season({ fieldIds: ['west'], fieldSize: '60/90' }).settings
      )
    ).deep.equals([east.availability.timezone])
    expect(seasonZones([east], { fieldSize: '50/70' })).deep.equals([
      east.availability.timezone
    ])
    expect(seasonZones([], season().settings)).deep.equals(['UTC'])
  })
})
