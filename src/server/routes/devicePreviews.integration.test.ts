import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import { makeId } from '../../common/ids'
import {
  asPreparedPreview,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { userIdOfGumbo } from '../../common/userId'
import { schedulerWorld } from '../../test/schedulerWorld'
import { hashToken } from '../auth/tokens'

/** Direct HTTP calls prove preparation does not compute and completion checks untrusted output. */
describe('device preview lifecycle', function () {
  this.timeout(120000)
  it('allows schedule-write API keys to prepare and complete but refuses read-only keys', async () => {
    const w = await schedulerWorld()
    const { h, leagueA } = w.fx.f
    try {
      const key = 'tsk_device_schedule_fixture'
      const id = makeId('userApiKey')
      await h.db
        .insertInto('user_api_keys')
        .values({
          id,
          user_id: userIdOfGumbo(101),
          name: 'Device scheduling fixture',
          token_hash: hashToken(key),
          secret_sealed: 'v1.unused',
          permissions: ['schedule:write']
        })
        .execute()
      const response = await h.request(
        'POST',
        `/leagues/${leagueA}/schedule-previews`,
        { mode: 'full', existing: 'workAround' },
        key
      )
      expect(response.status, await response.clone().text()).equals(201)
      const prepared = asPreparedPreview(await response.json())
      const result = buildOptions(prepared.input)
      const path = `/schedule-previews/${prepared.id}/result`
      await h.db
        .updateTable('user_api_keys')
        .set({ permissions: ['schedule:read'] })
        .where('id', '=', id)
        .execute()
      expect((await h.request('PUT', path, result, key)).status).equals(403)
      await h.db
        .updateTable('user_api_keys')
        .set({ permissions: ['schedule:write'] })
        .where('id', '=', id)
        .execute()
      const completed = await h.request('PUT', path, result, key)
      expect(completed.status, await completed.clone().text()).equals(200)
      expect((await completed.json()).status).equals('open')
    } finally {
      await w.close()
    }
  })
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
