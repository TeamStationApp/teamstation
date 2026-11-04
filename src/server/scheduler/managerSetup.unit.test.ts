import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asScheduleSetupChoice } from '../../common/seasonScheduling'
import { withQueryReplies } from '../../test/queryReplies'
import { saveScheduleSetup } from './setup'

describe('separate scheduler constraint writes', () => {
  for (const withSelections of [true, false]) {
    it(`updates only the submitted columns (selections=${withSelections})`, async () => {
      const request = asScheduleSetupChoice(
        withSelections
          ? { seasonIds: ['season'], fieldIds: ['field'] }
          : { avoidHeadCoachConflicts: false }
      )
      let written = false
      await withQueryReplies(
        ({ sql }) => {
          if (sql.startsWith('insert into "league_schedule_setups"')) {
            const updates = sql.split('do update set ')[1]
            expect(updates.includes('"season_ids"')).equals(withSelections)
            expect(updates.includes('"field_ids"')).equals(withSelections)
            expect(updates.includes('"avoid_head_coach_conflicts"')).equals(
              !withSelections
            )
            written = true
          }
          if (sql.startsWith('select "id" from "seasons"'))
            return [{ id: 'season' }]
          if (sql.startsWith('select "id" from "venue_fields"'))
            return [{ id: 'field' }]
          if (sql.includes('from "league_schedule_setups"'))
            return [
              {
                season_ids: [],
                field_ids: [],
                avoid_head_coach_conflicts: false
              }
            ]
          return []
        },
        async db => {
          const result = await saveScheduleSetup(db, 'league', request)
          expect(result.avoidHeadCoachConflicts).equals(false)
          expect(written).equals(true)
        }
      )
    })
  }
})
