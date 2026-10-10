import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asPublicGroup } from '../../common/publicGroups'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('following groups as a fan, and the groups one administers', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  const list = async (user: number): Promise<string[]> => {
    const response = await f.h.request('GET', '/me/follows', undefined, user)
    expect(response.status).equals(200)
    return ((await response.json()) as unknown[]).map(
      raw => asPublicGroup(raw).id
    )
  }
  it('follows and unfollows any league, season or team without granting access', async () => {
    expect(await list(104)).deep.equals([])
    for (const path of [
      `/me/follows/team/${f.teamB}`,
      `/me/follows/team/${f.teamB}`,
      `/me/follows/season/${f.seasonA}`,
      `/me/follows/league/${f.leagueB}`
    ])
      expect((await f.h.request('PUT', path, undefined, 104)).status).equals(
        200
      )
    expect(await list(104)).deep.equals([f.teamB, f.seasonA, f.leagueB])
    expect(await list(103)).deep.equals([])
    const detail = await f.h.request('GET', `/teams/${f.teamB}`, undefined, 104)
    expect(((await detail.json()) as { canManage: boolean }).canManage).equals(
      false
    )
    expect(
      (
        await f.h.request(
          'DELETE',
          `/me/follows/season/${f.seasonA}`,
          undefined,
          104
        )
      ).status
    ).equals(200)
    expect(await list(104)).deep.equals([f.teamB, f.leagueB])
  })
  it('refuses unknown groups, other kinds and anonymous callers', async () => {
    expect(
      (await f.h.request('PUT', '/me/follows/team/tem_missing', undefined, 104))
        .status
    ).equals(404)
    expect(
      (await f.h.request('PUT', `/me/follows/game/${f.teamB}`, undefined, 104))
        .status
    ).equals(400)
    expect(
      (await f.h.request('GET', '/me/follows', undefined, null)).status
    ).equals(401)
  })
  it('lists only what a person administers, with each season’s league', async () => {
    const response = await f.h.request(
      'GET',
      '/me/groups?role=admin',
      undefined,
      101
    )
    expect(response.status).equals(200)
    const groups = ((await response.json()) as unknown[]).map(raw =>
      asPublicGroup(raw)
    )
    const ids = groups.map(group => group.id)
    expect(ids).includes.members([f.leagueA, f.seasonA, f.playoffs, f.teamA])
    expect(ids).not.includes(f.leagueB)
    expect(ids).not.includes(f.seasonB)
    expect(groups.find(group => group.id === f.seasonA)?.leagueId).equals(
      f.leagueA
    )
    expect(groups.find(group => group.id === f.leagueA)?.leagueId).equals(null)
    expect(
      (await f.h.request('GET', '/me/groups?role=owner', undefined, 101)).status
    ).equals(400)
  })
})
