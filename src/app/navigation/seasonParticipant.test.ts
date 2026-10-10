import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asTeamSummary } from '../../common/api'
import { seasonParticipantDestination } from './seasonParticipant'

describe('season participant destinations', () => {
  for (const canViewPrivate of [true, false, undefined]) {
    it(`uses the private team permission rather than placeholder identity (${String(canViewPrivate)})`, () => {
      for (const kind of ['full', 'external'] as const) {
        const team = asTeamSummary({
          id: 'tem_demo',
          name: 'Demo participant',
          shortName: null,
          logoPath: null,
          kind,
          canViewPrivate
        })
        expect(seasonParticipantDestination(team)).deep.equals(
          canViewPrivate === true
            ? { name: 'team', team }
            : { name: 'group', kind: 'team', id: team.id }
        )
      }
    })
  }
})
