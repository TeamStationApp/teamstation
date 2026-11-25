import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { umpireFixture } from '../../test/umpireFixture'
import { runTool } from '../tess/tools'

/**
 * Tess's reads of umpire availability and commitments, through her own
 * api_get tool as the person she answers: on `umpireFixture` 101
 * administers Demo League A, and 104 holds its umpire role and nothing more.
 */
describe('Tess reads umpire availability and commitments', function () {
  this.timeout(60000)
  let f: GroupFixture
  const umpire = userIdOfGumbo(104)
  before(async () => {
    f = await umpireFixture()
    await f.h.db
      .insertInto('umpire_availability')
      .values({
        user_id: umpire,
        league_id: f.leagueA,
        days: [0, 1, 2, 3, 4],
        from_time: '17:00',
        to_time: '22:00',
        timezone: 'America/Los_Angeles'
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })
  const read = async (
    user: number,
    path: string,
    query: Record<string, unknown>
  ): Promise<{ status: string; body: any; is_error?: boolean }> => {
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
        id: 'toolu_availability',
        name: 'api_get',
        input: { path, query }
      }
    )
    const [status, ...body] = (outcome.result.content as string).split('\n')
    let parsed: unknown = body.join('\n')
    try {
      parsed = JSON.parse(body.join('\n'))
    } catch {
      // A refusal's text, kept as it is.
    }
    return { status, body: parsed, is_error: outcome.result.is_error }
  }
  const list = async (user: number): ReturnType<typeof read> =>
    await read(user, `/leagues/${f.leagueA}/umpires`, {
      // Tuesday 2027-04-13 at 18:30 in Los Angeles.
      availableAt: '2027-04-14T01:30:00.000Z',
      strict: true
    })
  const commitments = async (user: number): ReturnType<typeof read> =>
    await read(user, `/leagues/${f.leagueA}/umpires/${umpire}/commitments`, {
      from: '2027-04-01T00:00:00Z',
      to: '2027-04-08T00:00:00Z'
    })

  it('reads the umpires free at a time as an administrator', async () => {
    const answer = await list(101)
    expect(answer.is_error).equals(undefined)
    expect(answer.status).equals('HTTP 200')
    expect(
      answer.body.people.map((person: any) => [
        person.id,
        person.umpireAvailability.days
      ])
    ).deep.equals([[umpire, [0, 1, 2, 3, 4]]])
  })

  it('reads an umpire’s commitments as an administrator', async () => {
    const answer = await commitments(101)
    expect(answer.status).equals('HTTP 200')
    expect(answer.body.commitments).deep.equals([
      {
        gameId: 'gam_umpire',
        leagueId: f.leagueA,
        startAt: '2027-04-03T00:00:00.000Z',
        endAt: '2027-04-03T02:00:00.000Z',
        home: 'Demo Hawks',
        away: 'Demo Eagles',
        role: 'player'
      }
    ])
  })

  it('is refused both as an umpire who is no administrator', async () => {
    for (const answer of [await list(104), await commitments(104)]) {
      expect(answer.is_error).equals(true)
      expect(answer.status).equals('HTTP 403')
      expect(JSON.stringify(answer.body)).not.includes('17:00')
    }
  })
})
