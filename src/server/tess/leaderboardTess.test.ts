import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import {
  LEADERBOARD_RANKED,
  seedLeaderboard
} from '../../test/leaderboardFixture'
import { umpireFixture } from '../../test/umpireFixture'
import { stepLabel } from './stepLabels'
import { runTool } from './tools'

describe('Tess reads the umpire leaderboard', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await umpireFixture()
    await seedLeaderboard(f)
  })
  after(async () => {
    await f?.h.close()
  })
  const read = async (
    user: number,
    query: Record<string, unknown>
  ): Promise<{ content: unknown; is_error?: boolean }> => {
    const outcome = await runTool(
      {
        db: f.h.db,
        userId: userIdOfGumbo(user),
        origin: f.h.origin,
        credentials: { authorization: `Bearer ${f.h.tokens.get(user)!}` },
        now: new Date(),
        proposals: { count: 0 }
      },
      {
        type: 'tool_use',
        id: 'toolu_board',
        name: 'api_get',
        input: { path: `/leagues/${f.leagueA}/umpire-leaderboard`, query }
      }
    )
    return outcome.result
  }

  it('pages fewest first as an administrator, with a number for the limit', async () => {
    const result = await read(101, { order: 'asc', limit: 1 })
    expect(result.is_error).equals(undefined)
    const [status, ...body] = String(result.content).split('\n')
    expect(status).equals('HTTP 200')
    const board = JSON.parse(body.join('\n'))
    expect(board.scheduled).length(1)
    expect(board.scheduled[0].count).equals(0)
    expect(board.page).deep.equals({
      order: 'asc',
      limit: 1,
      offset: 0,
      total: 15
    })
  })

  it('is refused pages as an umpire, with what the person may do', async () => {
    const result = await read(LEADERBOARD_RANKED[11].id, { limit: 5 })
    expect(result.is_error).equals(true)
    expect(String(result.content)).match(/^HTTP 403\n/)
    expect(String(result.content)).includes('league administrator')
  })

  it('labels the step with the route’s summary', () => {
    expect(
      stepLabel({
        name: 'api_get',
        input: { path: `/leagues/${f.leagueA}/umpire-leaderboard` }
      })
    ).match(/^Reading: Umpires ranked by completed and scheduled games/)
  })
})
