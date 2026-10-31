import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { defaultNodeSettings, type NodeSettings } from '../common/nodeSettings'
import { userIdOfGumbo } from '../common/userId'
import { type GroupFixture, groupFixture } from '../test/groupFixtures'
import {
  forgetScoreboardSettings,
  replayPitchSec,
  replaySettings,
  scoreboardOverlayFor,
  scoreboardSettings,
  speedHoldMs
} from './nodeSettings'
import { forgetSettings, highlightSettings } from './settings'

describe('node settings', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    forgetScoreboardSettings()
    forgetSettings()
  })
  afterEach(async () => {
    forgetScoreboardSettings()
    forgetSettings()
    await f?.h.close()
  })

  const changed: NodeSettings = {
    radar: { pitchWindowSec: 4, inPlayWindowSec: 20 },
    replay: { pitchSec: 7 },
    scoreboard: {
      overlayStartDate: '2026-11-15',
      single: { x: 0.1, y: 0.2, height: 0.25 },
      landscape: { x: 0.02, y: 0.03, height: 0.2 },
      tvLandscape: { x: 0.03, y: 0.04, height: 0.1 },
      portraitHeight: 0.3,
      speedHoldSec: 3
    },
    highlights: {
      lagSec: 6,
      leadSec: 20,
      leadSecByEventType: { strikeout: 8, walk: 4 },
      mergeWithinSec: 2,
      tailSec: 9
    }
  }

  it('lets only a node administrator read and set them, all at once, and records who', async () => {
    expect(
      (await f.h.request('GET', '/node/settings', undefined, null)).status
    ).equals(401)
    expect(
      (await f.h.request('GET', '/node/settings', undefined, 101)).status
    ).equals(403)
    expect(
      (await f.h.request('PUT', '/node/settings', changed, 101)).status
    ).equals(403)

    const first = await f.h.request('GET', '/node/settings', undefined, 105)
    expect(first.status).equals(200)
    expect(await first.json()).deep.equals(defaultNodeSettings)

    const bad = await f.h.request(
      'PUT',
      '/node/settings',
      {
        ...changed,
        scoreboard: { ...changed.scoreboard, single: { x: 2, y: 0, height: 1 } }
      },
      105
    )
    expect(bad.status).equals(400)
    expect(JSON.stringify(await bad.json())).contains(
      'scoreboard.single.x must be a number from 0 to under 1'
    )

    const set = await f.h.request('PUT', '/node/settings', changed, 105)
    expect(set.status).equals(200)
    expect(await set.json()).deep.equals(changed)
    const read = await f.h.request('GET', '/node/settings', undefined, 105)
    expect(await read.json()).deep.equals(changed)

    // What the rest of the server reads moves with it at once.
    expect(await highlightSettings(f.h.db)).deep.equals(changed.highlights)
    expect(await speedHoldMs(f.h.db)).equals(3000)
    // The replay's delay too, which needs nobody signed in.
    expect(await replayPitchSec(f.h.db)).equals(7)

    const rows = await f.h.db
      .selectFrom('system_settings')
      .select(['key', 'updated_by'])
      .where('key', 'in', [
        'replay.pitchSec',
        'radar.pitchWindowSec',
        'radar.inPlayWindowSec',
        'scoreboard.overlayStartDate',
        'scoreboard.single',
        'scoreboard.landscape',
        'scoreboard.portraitHeight',
        'scoreboard.speedHoldSec',
        'highlights.lagSec',
        'highlights.leadSec',
        'highlights.leadSecByEventType',
        'highlights.mergeWithinSec',
        'highlights.tailSec'
      ])
      .execute()
    expect(rows).has.length(13)
    expect(new Set(rows.map(row => row.updated_by))).deep.equals(
      new Set([userIdOfGumbo(105)])
    )
  })

  it('preserves TV placement on legacy saves and refreshes another worker’s TV placement immediately', async () => {
    expect(
      (await f.h.request('PUT', '/node/settings', changed, 105)).status
    ).equals(200)
    const { tvLandscape: tv, ...legacy } = changed.scoreboard
    expect(
      (
        await f.h.request(
          'PUT',
          '/node/settings',
          { ...changed, scoreboard: legacy },
          105
        )
      ).status
    ).equals(200)
    expect(
      (await scoreboardOverlayFor(f.h.db, '2027-01-01')).tvLandscape
    ).deep.equals(tv)
    const next = { x: 0.15, y: 0.12, height: 0.3 }
    await f.h.db
      .updateTable('system_settings')
      .set({ value: JSON.stringify(next) })
      .where('key', '=', 'scoreboard.tvLandscape')
      .execute()
    const overlay = await scoreboardOverlayFor(f.h.db, '2027-01-01')
    expect(overlay.tvLandscape).deep.equals(next)
    expect(overlay.landscape).deep.equals(changed.scoreboard.landscape)
    expect((await scoreboardOverlayFor(f.h.db, '2020-01-01')).show).equals(
      false
    )
    await f.h.db
      .updateTable('system_settings')
      .set({ value: JSON.stringify({ height: -1 }) })
      .where('key', '=', 'scoreboard.tvLandscape')
      .execute()
    expect(
      (await scoreboardOverlayFor(f.h.db, '2027-01-01')).tvLandscape
    ).deep.equals(defaultNodeSettings.scoreboard.tvLandscape)
  })

  it('keeps the node’s tail when an app that sends no tailSec saves', async () => {
    // The node's own, saved by an app that knows the setting.
    expect(
      (await f.h.request('PUT', '/node/settings', changed, 105)).status
    ).equals(200)
    const { tailSec: _tail, ...older } = changed.highlights
    const set = await f.h.request(
      'PUT',
      '/node/settings',
      { ...changed, highlights: older },
      105
    )
    expect(set.status).equals(200)
    expect((await set.json()).highlights.tailSec).equals(
      changed.highlights.tailSec
    )
    expect((await highlightSettings(f.h.db, true)).tailSec).equals(
      changed.highlights.tailSec
    )
  })

  it('rejects invalid radar windows and defaults malformed stored windows independently', async () => {
    for (const key of ['pitchWindowSec', 'inPlayWindowSec'])
      for (const value of [0, -1, 601, '3', null]) {
        const response = await f.h.request(
          'PUT',
          '/node/settings',
          { ...changed, radar: { ...changed.radar, [key]: value } },
          105
        )
        expect(response.status).equals(400)
      }
    await f.h.db
      .insertInto('system_settings')
      .values([
        { key: 'radar.pitchWindowSec', value: JSON.stringify(-1) },
        { key: 'radar.inPlayWindowSec', value: JSON.stringify(12) },
        { key: 'radar.unknown', value: JSON.stringify(8) }
      ])
      .execute()
    const response = await f.h.request('GET', '/node/settings', undefined, 105)
    expect((await response.json()).radar).deep.equals({
      pitchWindowSec: 3,
      inPlayWindowSec: 12
    })
  })

  it('reads the replay delay as 5 with no row or a bad one, keeps it for a body without it, and caches', async () => {
    const now = Date.now()
    expect(await replaySettings(f.h.db, now)).deep.equals({ pitchSec: 5 })
    expect(await replayPitchSec(f.h.db)).equals(5)
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'replay.pitchSec', value: JSON.stringify(2.5) })
      .execute()
    expect(await replaySettings(f.h.db, now + 31000)).deep.equals({
      pitchSec: 5
    })
    await f.h.db
      .updateTable('system_settings')
      .set({ value: JSON.stringify(9) })
      .where('key', '=', 'replay.pitchSec')
      .execute()
    // Cached for 30 s, then read again.
    expect((await replaySettings(f.h.db, now + 32000)).pitchSec).equals(5)
    expect((await replaySettings(f.h.db, now + 62000)).pitchSec).equals(9)
    // A body from an older screen, with no replay, keeps the stored delay.
    const { replay: _replay, ...older } = changed
    const set = await f.h.request('PUT', '/node/settings', older, 105)
    expect(set.status).equals(200)
    expect((await set.json()).replay).deep.equals({ pitchSec: 9 })
    expect(await replayPitchSec(f.h.db)).equals(9)
    const row = await f.h.db
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', 'replay.pitchSec')
      .executeTakeFirstOrThrow()
    expect(row.value).equals(9)
  })

  it('falls back to the default for each value a row holds badly, and caches', async () => {
    await f.h.db
      .insertInto('system_settings')
      .values([
        { key: 'scoreboard.overlayStartDate', value: JSON.stringify('soon') },
        {
          key: 'scoreboard.single',
          value: JSON.stringify({ x: 0.3, y: 0.4, height: 0.5 })
        },
        { key: 'scoreboard.landscape', value: JSON.stringify({ x: 9 }) },
        { key: 'scoreboard.portraitHeight', value: JSON.stringify(0.4) },
        { key: 'scoreboard.speedHoldSec', value: JSON.stringify(-1) }
      ])
      .execute()
    const now = Date.now()
    expect(await scoreboardSettings(f.h.db, now)).deep.equals({
      ...defaultNodeSettings.scoreboard,
      single: { x: 0.3, y: 0.4, height: 0.5 },
      portraitHeight: 0.4
    })
    await f.h.db
      .updateTable('system_settings')
      .set({ value: JSON.stringify(0.6) })
      .where('key', '=', 'scoreboard.portraitHeight')
      .execute()
    expect(
      (await scoreboardSettings(f.h.db, now + 1000)).portraitHeight
    ).equals(0.4)
    expect(
      (await scoreboardSettings(f.h.db, now + 31000)).portraitHeight
    ).equals(0.6)
  })

  it('reads highlight values the screen would refuse as their defaults, so the screen still opens', async () => {
    // Migrations seed these rows: each is set to what the screen refuses.
    const rows: Array<[string, unknown]> = [
      ['highlights.lagSec', -3],
      ['highlights.leadSec', 900],
      ['highlights.mergeWithinSec', 4],
      ['highlights.leadSecByEventType', { Strikeout: 10 }],
      ['highlights.tailSec', 'five']
    ]
    for (const [key, value] of rows)
      await f.h.db
        .insertInto('system_settings')
        .values({ key, value: JSON.stringify(value) })
        .onConflict(oc =>
          oc.column('key').doUpdateSet({ value: JSON.stringify(value) })
        )
        .execute()
    const read = await f.h.request('GET', '/node/settings', undefined, 105)
    expect(read.status).equals(200)
    expect(await read.json()).deep.include({
      highlights: {
        ...defaultNodeSettings.highlights,
        mergeWithinSec: 4
      }
    })
  })

  it('reads past this worker’s cache for the administration screen and the hub', async () => {
    const first = await f.h.request('GET', '/node/settings', undefined, 105)
    expect(first.status).equals(200)
    expect(await speedHoldMs(f.h.db)).equals(5000)
    // Another worker took a save: this one's caches were not told.
    const rows: Array<[string, unknown]> = [
      ['scoreboard.speedHoldSec', 7],
      ['highlights.lagSec', 9]
    ]
    for (const [key, value] of rows)
      await f.h.db
        .insertInto('system_settings')
        .values({ key, value: JSON.stringify(value) })
        .onConflict(oc =>
          oc.column('key').doUpdateSet({ value: JSON.stringify(value) })
        )
        .execute()
    const read = (await (
      await f.h.request('GET', '/node/settings', undefined, 105)
    ).json()) as NodeSettings
    expect(read.scoreboard.speedHoldSec).equals(7)
    expect(read.highlights.lagSec).equals(9)
    expect(await speedHoldMs(f.h.db)).equals(7000)
  })
})
