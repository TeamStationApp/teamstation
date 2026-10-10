import { execFileSync } from 'node:child_process'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'

describe('large real photos through the production JSON boundary', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('stores a valid image whose base64 exceeds one MiB during onboarding, creation and later group editing', async () => {
    const bytes = execFileSync(
      process.env.TS_FFMPEG ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=white:s=600x600',
        '-frames:v',
        '1',
        '-c:v',
        'png',
        '-compression_level',
        '0',
        '-f',
        'image2pipe',
        'pipe:1'
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    expect(bytes.length).greaterThan(800 * 1024)
    const image = { contentType: 'image/png', base64: bytes.toString('base64') }
    expect(image.base64.length).greaterThan(1024 * 1024)
    await f.h.db
      .updateTable('users')
      .set({ onboarding_step: 'photo', onboarding_completed_at: null })
      .where('id', '=', 106)
      .execute()
    const onboarding = await f.h.request(
      'PUT',
      '/me/onboarding/photo',
      { image },
      106
    )
    expect(onboarding.status, await onboarding.clone().text()).equals(200)
    const user = await f.h.db
      .selectFrom('users')
      .select(['onboarding_step', 'avatar_path'])
      .where('id', '=', 106)
      .executeTakeFirstOrThrow()
    expect(user.onboarding_step).equals('complete')
    expect(user.avatar_path).not.equals(null)
    for (const kind of ['league', 'season', 'team'] as const) {
      const route =
        kind === 'league' ? 'leagues' : kind === 'season' ? 'seasons' : 'teams'
      const created = await f.h.request(
        'POST',
        '/' + route.toUpperCase() + '/',
        {
          name: `Demo Large Photo ${kind}`,
          locality: demoLocality,
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          timezone: 'UTC',
          picture: { image },
          idempotencyKey: `large-photo-${kind}`
        },
        101
      )
      expect(created.status, await created.clone().text()).equals(201)
      const group = (await created.json()) as {
        id: string
        imageUrl: string | null
      }
      expect(group.imageUrl).not.equals(null)
      const updated = await f.h.request(
        'PUT',
        `/GROUPS/${kind}/${group.id}/`,
        { picture: { image } },
        101
      )
      expect(updated.status, await updated.clone().text()).equals(200)
      expect(await updated.json())
        .property('imageUrl')
        .not.equals(null)
    }
  })
})
