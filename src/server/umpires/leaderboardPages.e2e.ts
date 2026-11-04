import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { expect } from 'chai'

import {
  LEADERBOARD_RANKED,
  seedLeaderboard
} from '../../test/leaderboardFixture'
import { umpireFixture } from '../../test/umpireFixture'
import { instructions } from '../tess/prompt'

/**
 * The umpire leaderboard over real HTTP, with `curl` against a real port: the
 * default answer, a page each way, past the end, and each refusal. Not part
 * of `npm test`.
 *
 *   node -r sucrase/register src/server/umpires/leaderboardPages.e2e.ts [--before | --tess-index]
 *
 * `--before` prints the answers without checking them. `--tess-index` prints
 * the line of Tess's API index for this route, and starts nothing.
 */

interface Rank {
  count: number
}
interface Board {
  scheduled: Rank[]
  completed: Rank[]
  page?: { total: number }
}

async function main(): Promise<void> {
  if (process.argv.includes('--tess-index')) {
    console.log(
      '$ node -r sucrase/register src/server/umpires/leaderboardPages.e2e.ts --tess-index'
    )
    const line = instructions()
      .split('\n')
      .find(each =>
        each.startsWith('GET /leagues/{leagueId}/umpire-leaderboard')
      )
    console.log(line)
    expect(line).includes('Query: order, limit, offset')
    return
  }
  const check = !process.argv.includes('--before')
  const f = await umpireFixture()
  try {
    await seedLeaderboard(f)
    const umpire = LEADERBOARD_RANKED[11].id
    const route = `${f.h.origin}/api/v1/leagues/${f.leagueA}/umpire-leaderboard`
    // Asynchronous, because this process is also the server curl is calling.
    const get = async (
      query: string,
      user = 101
    ): Promise<{ status: number; board: Board }> => {
      const url = query === '' ? route : `${route}?${query}`
      const name = user === 101 ? 'ADMIN_TOKEN' : 'UMPIRE_TOKEN'
      console.log(`\n$ curl -sS -H "Authorization: Bearer $${name}" '${url}'`)
      const { stdout: out } = await promisify(execFile)('curl', [
        '-sS',
        '-w',
        '\nHTTP %{http_code}',
        '-H',
        `Authorization: Bearer ${f.h.tokens.get(user)!}`,
        url
      ])
      console.log(out)
      const at = out.lastIndexOf('\nHTTP ')
      return {
        status: Number(out.slice(at + 6)),
        board: JSON.parse(out.slice(0, at))
      }
    }
    const shows = (assertion: () => void): void => {
      if (check) assertion()
    }

    const top = await get('')
    shows(() => {
      expect(top.status).equals(200)
      expect(top.board.scheduled).length(10)
      expect(top.board.scheduled.every(p => p.count > 0)).equals(true)
      expect(top.board).not.has.property('page')
    })
    const fewest = await get('order=asc&limit=5')
    shows(() => {
      expect(fewest.status).equals(200)
      expect(fewest.board.scheduled).length(5)
      expect(fewest.board.scheduled[0].count).equals(0)
      expect(fewest.board.page?.total).equals(15)
    })
    const next = await get('offset=5&limit=5')
    shows(() => {
      expect(next.status).equals(200)
      expect(next.board.scheduled.map(p => p.count)).deep.equals([
        7, 6, 5, 4, 3
      ])
    })
    const past = await get('offset=1000')
    shows(() => {
      expect(past.status).equals(200)
      expect(past.board.scheduled).length(0)
      expect(past.board.page?.total).equals(15)
    })
    const tooMany = await get('limit=51')
    shows(() => {
      expect(tooMany.status).equals(400)
    })
    const refused = await get('limit=5', umpire)
    shows(() => {
      expect(refused.status).equals(403)
    })
    if (check) console.log('\nUmpire leaderboard pages passed.')
  } finally {
    await f.h.close()
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
