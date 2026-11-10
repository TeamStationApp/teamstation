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
import { purgeReplacedRecordings } from './purge'

const now = new Date('2026-10-23T00:00:00.000Z')
const lastMonth = new Date('2026-09-23T00:00:00.000Z')

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
