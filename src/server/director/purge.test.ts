import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import { startFakeSpace } from '../dev/fakeSpace'
import { putObject } from '../media/images'
import type { SpaceSettings } from '../media/spacesHls'
import { listSpaceObjects } from '../media/spacesVideo'
import { dueForPurge, type Purgeable, purgeReplacedRecordings } from './purge'

const now = new Date('2026-10-23T00:00:00.000Z')
const lastMonth = new Date('2026-09-23T00:00:00.000Z')
const nextMonth = new Date('2026-11-23T00:00:00.000Z')

const replaced = (over: Partial<Purgeable> = {}): Purgeable => ({
  id: 'vid_live',
  purgeAfter: lastMonth,
  hidden: true,
  replacedBy: 'vid_upload',
  ...over
})

describe('which replaced recordings are due to go', function () {
  it('takes one whose month is up', function () {
    expect(dueForPurge([replaced()], now)).deep.equals(['vid_live'])
  })

  it('leaves one whose month is not up yet', function () {
    // The month is the whole point: a replacement nobody has checked has four
    // weeks to be noticed and undone.
    expect(dueForPurge([replaced({ purgeAfter: nextMonth })], now)).deep.equals(
      []
    )
  })

  it('leaves a recording nobody dated', function () {
    expect(dueForPurge([replaced({ purgeAfter: null })], now)).deep.equals([])
  })

  it('leaves one somebody has brought back out of hiding', function () {
    // Un-hiding is a person acting on it. An old purge date is not a reason to
    // delete a recording behind them.
    expect(dueForPurge([replaced({ hidden: false })], now)).deep.equals([])
  })

  it('leaves one whose replacement has since been deleted', function () {
    // Deleting the replacement clears the pointer and un-hides this, and the
    // reason it was going to be deleted went with it.
    expect(dueForPurge([replaced({ replacedBy: null })], now)).deep.equals([])
  })

  it('leaves a recording PeerTube still owns', function () {
    // The delete route refuses one of these for the same reason: this server
    // reads that tree and does not own it.
    expect(dueForPurge([replaced({ storage: 'peertube' })], now)).deep.equals(
      []
    )
  })

  it('takes only what is due, out of a mixture', function () {
    const videos = [
      replaced({ id: 'vid_due' }),
      replaced({ id: 'vid_early', purgeAfter: nextMonth }),
      replaced({ id: 'vid_rescued', hidden: false }),
      replaced({ id: 'vid_orphan', replacedBy: null }),
      replaced({ id: 'vid_also_due', purgeAfter: lastMonth })
    ]
    expect(dueForPurge(videos, now)).deep.equals(['vid_due', 'vid_also_due'])
  })
})

describe('purging a replaced recording under its secret path', function () {
  this.timeout(60000)
  const SECRET = '0123456789abcdef0123456789abcdef'

  it('deletes both of its prefixes with the secret its row holds', async function () {
    const { db, drop } = await scratchDatabase('purge_secret')
    const root = await mkdtemp(join(tmpdir(), 'tsPurgeSecret-'))
    const space: SpaceSettings = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    const fake = await startFakeSpace({ space, dir: join(root, 'space') })
    space.endpoint = fake.url
    try {
      const gameId = await addGame(db, {
        homeTeamId: await addTeam(db, 'Pioneers'),
        awayTeamId: await addTeam(db, 'Visitors'),
        startAt: new Date()
      })
      for (const [id, secret] of [
        ['vid_upload', null],
        ['vid_live', SECRET]
      ] as const)
        await db
          .insertInto('videos')
          .values({
            id,
            game_id: gameId,
            kind: id === 'vid_live' ? 'live' : 'program',
            title: id,
            storage: 'spaces',
            space_secret: secret
          })
          .execute()
      await db
        .updateTable('videos')
        .set({
          hidden: true,
          replaced_by: 'vid_upload',
          purge_after: lastMonth
        })
        .where('id', '=', 'vid_live')
        .execute()
      for (const key of [
        `videos/vid_live-${SECRET}/video.mp4`,
        `videos/vid_live-${SECRET}/video.m3u8`,
        'videos/vid_live/stills/150.jpg',
        'videos/vid_upload/stills/1.jpg'
      ])
        await putObject({
          space,
          key,
          body: Buffer.from('x'),
          contentType: 'video/mp4'
        })
      expect(
        await purgeReplacedRecordings({
          db,
          space,
          mediaDir: root,
          now
        })
      ).deep.equals(['vid_live'])
      expect(await listSpaceObjects(space, 'videos/')).deep.equals([
        'videos/vid_upload/stills/1.jpg'
      ])
    } finally {
      fake.server.close()
      await drop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
