import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import {
  asPreparedPreview,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { schedulerWorld } from '../../test/schedulerWorld'

/** Direct HTTP calls prove preparation does not compute and completion checks untrusted output. */
describe('device preview lifecycle', function () {
  this.timeout(120000)
  it('prepares without options, rejects invalid results, completes once and publishes', async () => {
    const w = await schedulerWorld()
    const { f } = w.fx
    try {
      const response = await f.h.request(
        'POST',
        `/leagues/${f.leagueA}/schedule-previews`,
        { mode: 'full', existing: 'workAround' },
        101
      )
      expect(response.status).equals(201)
      const prepared = asPreparedPreview(await response.json())
      const row = await f.h.db
        .selectFrom('schedule_previews')
        .selectAll()
        .where('id', '=', prepared.id)
        .executeTakeFirstOrThrow()
      expect(row.status).equals('building')
      expect(row.options).deep.equals([])
      expect(
        (
          await f.h.request(
            'POST',
            `/schedule-previews/${prepared.id}/publications`,
            { option: 0 },
            101
          )
        ).status
      ).equals(409)
      const result = buildOptions(prepared.input)
      expect(result.options.length).greaterThan(0)
      const path = `/schedule-previews/${prepared.id}/result`
      expect((await f.h.request('PUT', path, result, 102)).status).equals(403)
      const first = result.options[0].games[0]
      for (const bad of [
        { ...first, fieldId: 'fld_unselected' },
        { ...first, awayTeamId: first.homeTeamId },
        { ...first, endAt: first.startAt },
        { ...first, startAt: 'invalid' },
        { ...first, size: '60/90' },
        { ...first, key: '', startAt: first.startAt }
      ]) {
        const rejected = await f.h.request(
          'PUT',
          path,
          { options: [{ games: [bad] }], blocking: null },
          101
        )
        expect(rejected.status, await rejected.text()).equals(400)
      }
      expect(
        (
          await f.h.request(
            'PUT',
            path,
            { options: [{ games: [first, first] }], blocking: null },
            101
          )
        ).status
      ).equals(400)
      const accepted = await f.h.request('PUT', path, result, 101)
      expect(accepted.status, await accepted.clone().text()).equals(200)
      const preview = (await accepted.json()) as SchedulePreview
      expect(preview.status).equals('open')
      expect(preview.options[0].games).deep.equals(result.options[0].games)
      expect(preview.options[0].fairness).deep.equals(
        result.options[0].fairness
      )
      expect(
        await (await f.h.request('PUT', path, result, 101)).json()
      ).deep.equals(preview)
      expect(
        (
          await f.h.request(
            'PUT',
            path,
            { options: [], blocking: 'different' },
            101
          )
        ).status
      ).equals(409)
      expect(
        (
          await f.h.request(
            'POST',
            `/schedule-previews/${prepared.id}/publications`,
            { option: 0 },
            101
          )
        ).status
      ).equals(200)
    } finally {
      await w.close()
    }
  })
})
