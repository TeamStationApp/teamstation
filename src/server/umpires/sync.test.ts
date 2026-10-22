import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import {
  listenScreenScopes,
  type ScreenScopeNotices
} from '../../test/screenScopeNotices'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { readSyncClock, REVISION_HEADER } from '../socket/syncRevision'

describe('umpire changes in live screen snapshots', function () {
  this.timeout(60000)
  let f: GroupFixture
  let notices: ScreenScopeNotices
  let previous: string | undefined
  beforeEach(async () => {
    previous = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    notices = await listenScreenScopes(f.h.db)
  })
  afterEach(async () => {
    await notices?.close()
    await f?.h.close()
    if (previous == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = previous
  })
  async function changed(
    method: string,
    path: string,
    body: unknown
  ): Promise<void> {
    const before = await readSyncClock(f.h.db)
    const mark = notices.mark()
    const result = await f.h.request(method, path, body, 101)
    expect(result.status, await result.clone().text()).equals(200)
    const notice = await notices.named(mark, { gameId: 'gam_umpire' })
    expect(BigInt(notice.revision)).equals(BigInt(before) + 1n)
    const game = await f.h.request('GET', '/games/gam_umpire', undefined, 101)
    expect(game.status).equals(200)
    expect(game.headers.get(REVISION_HEADER)).equals(notice.revision)
  }
  const signup = async (): Promise<void> => {
    await changed('POST', '/games/gam_umpire/umpire-slots', {
      slot: 'uty_plate:1',
      userId: userIdOfGumbo(101)
    })
  }
  it('announces signup and removal at the revision of the changed game projection', async () => {
    await signup()
    const detail = await (
      await f.h.request('GET', '/games/gam_umpire', undefined, 101)
    ).json()
    expect(detail.umpires.positions[0].person.userId).equals(userIdOfGumbo(101))
    await changed('DELETE', '/games/gam_umpire/umpire-slots', {
      slot: 'uty_plate:1'
    })
  })
  it('announces management visibility, requirements, revocation and type removal', async () => {
    await signup()
    const league = `/leagues/${f.leagueA}`
    await changed('PUT', `${league}/umpire-settings`, { management: false })
    await changed('PUT', `${league}/umpire-settings`, { management: true })
    await changed('PUT', `${league}/umpire-requirements`, {
      seasonIds: [f.seasonA],
      levelId: 'ulv_majors',
      types: [
        { typeId: 'uty_plate', required: 1, optional: 0 },
        { typeId: 'uty_field', required: 1, optional: 0 }
      ]
    })
    await changed(
      'DELETE',
      `${league}/umpires/${userIdOfGumbo(101)}`,
      undefined
    )
    await changed('DELETE', `${league}/umpire-types/uty_plate`, undefined)
    await changed('DELETE', `${league}/umpire-levels/ulv_majors`, undefined)
  })
  it('does not announce rejected writes or advance the clock for a read', async () => {
    const before = await readSyncClock(f.h.db)
    const mark = notices.mark()
    const response = await f.h.request(
      'POST',
      '/games/gam_umpire/umpire-slots',
      {},
      101
    )
    expect(response.status).equals(400)
    await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-types`,
      undefined,
      101
    )
    expect(await readSyncClock(f.h.db)).equals(before)
    expect(await notices.since(mark)).deep.equals([])
  })
})
