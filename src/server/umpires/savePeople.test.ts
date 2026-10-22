import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { umpireEdits, umpireStateKey } from '../../common/umpireEdits'
import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { umpireFixture } from '../../test/umpireFixture'
import { fixtureCertifications } from '../../test/umpireTypes'

describe('atomic umpire draft saves', function () {
  this.timeout(60000)
  let f: GroupFixture
  let client: TeamStationClient
  const empty = { certifications: [] }
  const both = {
    certifications: [...fixtureCertifications('ulv_majors', true, true)]
  }
  beforeEach(async () => {
    f = await umpireFixture()
    client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const save = async (
    body: unknown,
    actor: number | null = 101
  ): Promise<Response> =>
    await f.h.request('PUT', `/leagues/${f.leagueA}/umpires`, body, actor)

  it('saves a semantic diff once, preserves unrelated people, and retries idempotently', async () => {
    const baseline = await client.umpirePeople(f.leagueA)
    const draft = baseline.map(p =>
      p.id === userIdOfGumbo(101) ? { ...p, certifications: [] } : p
    )
    const changes = umpireEdits(baseline, draft)
    expect(changes.length).equals(1)
    const saved = await client.saveUmpires(f.leagueA, changes)
    expect(umpireEdits(saved, draft)).deep.equals([])
    expect(
      umpireStateKey(saved.find(p => p.id === userIdOfGumbo(104))!)
    ).equals(umpireStateKey(both))
    expect(
      umpireEdits(saved, await client.saveUmpires(f.leagueA, changes))
    ).deep.equals([])
    expect(umpireEdits(draft, baseline).length).equals(1)
    expect(
      umpireStateKey({
        certifications: [...fixtureCertifications('ulv_majors', false, false)]
      })
    ).equals(umpireStateKey(empty))
    expect(
      umpireStateKey({
        certifications: [
          ...both.certifications,
          ...fixtureCertifications('a', true, false)
        ]
      })
    ).equals(
      umpireStateKey({
        certifications: [
          ...fixtureCertifications('a', true, false),
          ...both.certifications
        ]
      })
    )
    expect((await save({ changes: [] })).status).equals(200)
  })
  it('stages additions and revokes, preserves dormant permissions when requested, and rolls back late failures', async () => {
    const id = userIdOfGumbo(104)
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'uty_plate:1',
        user_id: id,
        assigned_by: userIdOfGumbo(101)
      })
      .execute()
    const revoke = { userId: id, before: both, after: null }
    const denied = { userId: userIdOfGumbo(102), before: null, after: empty }
    expect((await save({ changes: [revoke, denied] })).status).equals(400)
    expect((await client.umpirePeople(f.leagueA)).length).equals(2)
    expect(
      (await f.h.db.selectFrom('umpire_assignments').selectAll().execute())
        .length
    ).equals(1)
    const old = await client.umpirePeople(f.leagueA)
    const reduced = old.filter(p => p.id !== id)
    const changes = umpireEdits(old, reduced)
    expect((await client.saveUmpires(f.leagueA, changes)).length).equals(1)
    expect(
      (await f.h.db.selectFrom('umpire_assignments').selectAll().execute())
        .length
    ).equals(0)
    const readded = await client.saveUmpires(f.leagueA, [
      { userId: id, before: null, after: both }
    ])
    expect(umpireStateKey(readded.find(p => p.id === id)!)).equals(
      umpireStateKey(both)
    )
    expect(umpireEdits(reduced, readded).length).equals(1)
  })
  it('rejects stale touched people and foreign levels without partial updates', async () => {
    const a = { userId: userIdOfGumbo(101), before: both, after: empty }
    const b = {
      userId: userIdOfGumbo(104),
      before: empty,
      after: {
        certifications: [...fixtureCertifications('ulv_majors', false, true)]
      }
    }
    expect((await save({ changes: [a, b] })).status).equals(409)
    expect(umpireStateKey((await client.umpirePeople(f.leagueA))[0])).equals(
      umpireStateKey(both)
    )
    expect(
      (
        await save({
          changes: [
            {
              ...a,
              after: {
                certifications: [
                  ...fixtureCertifications('foreign', true, false)
                ]
              }
            }
          ]
        })
      ).status
    ).equals(400)
    expect((await save({ changes: [a] }, null)).status).equals(401)
    expect((await save({ changes: [a] }, 103)).status).equals(403)
  })
  it('validates bounded objects, unique people and certification fields', async () => {
    const edit = { userId: userIdOfGumbo(101), before: both, after: empty }
    for (const body of [
      null,
      [],
      {},
      { changes: {} },
      { changes: Array(501).fill(edit) },
      { changes: [null] },
      { changes: [{ ...edit, userId: '' }] },
      { changes: [edit, edit] },
      { changes: [{ ...edit, before: undefined }] },
      { changes: [{ ...edit, after: { certifications: {} } }] },
      {
        changes: [
          {
            ...edit,
            after: { certifications: Array(10001).fill(both.certifications[0]) }
          }
        ]
      },
      { changes: [{ ...edit, after: { certifications: [null] } }] },
      ...[
        { levelId: '', typeId: 'uty_plate', enabled: true },
        { levelId: 'ulv_majors', typeId: 'uty_plate', enabled: 1 },
        { levelId: 'ulv_majors', typeId: 1, enabled: true }
      ].map(c => ({ changes: [{ ...edit, after: { certifications: [c] } }] })),
      {
        changes: [
          {
            ...edit,
            after: {
              certifications: [...both.certifications, ...both.certifications]
            }
          }
        ]
      }
    ])
      expect(
        (await save(body)).status,
        JSON.stringify(body)?.slice(0, 150)
      ).equals(400)
  })
  it('rejects merged edit ids and permits only the same-league administrator to open role-only profiles', async () => {
    const id = userIdOfGumbo(106)
    const alias = userIdOfGumbo(103)
    const profile = async (league: string, actor: number): Promise<Response> =>
      await f.h.request(
        'GET',
        `/leagues/${league}/people/${id}`,
        undefined,
        actor
      )
    expect((await profile(f.leagueA, 101)).status).equals(404)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: id })
      .where('id', '=', alias)
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: alias,
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    const visible = await profile(f.leagueA, 101)
    expect(visible.status).equals(200)
    const profileBody = await visible.json()
    expect(profileBody.viewer).deep.equals({ manages: false, admin: false })
    expect(
      profileBody.sections.every(
        (section: { editable: boolean }) => !section.editable
      )
    ).equals(true)
    expect((await profile(f.leagueA, 104)).status).equals(404)
    expect((await profile(f.leagueB, 102)).status).equals(404)
    expect(
      (await save({ changes: [{ userId: alias, before: empty, after: both }] }))
        .status
    ).equals(409)
  })
})
