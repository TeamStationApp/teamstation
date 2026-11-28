import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { TeamStationClient } from '../../common/api'
import { asGameScheduleProposal } from '../../common/gameApprovals'
import { asGroupDetail } from '../../common/publicGroups'
import { mount, settle, text, unmount } from '../../test/gameFormDom'
import { GroupGameSchedule } from './GroupGameSchedule'

const proposal = (
  requestId: string,
  homeTeamId: string,
  awayTeamId: string
): ReturnType<typeof asGameScheduleProposal> =>
  asGameScheduleProposal({
    requestId,
    gameId: null,
    game: {
      homeTeamId,
      awayTeamId,
      seasonId: 'season-1',
      startAt: '2027-04-03T14:00:00.000Z',
      venue: 'Field 2',
      outsideTournament: null,
      status: 'scheduled'
    },
    previous: null,
    status: 'pending',
    sentAt: '2027-01-01T00:00:00.000Z',
    canDelete: false,
    version: null
  })

function fixture(rows: Array<ReturnType<typeof asGameScheduleProposal>>): {
  client: TeamStationClient
  read: string[]
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const read: string[] = []
  client.gameProposals = async () => rows
  client.group = async ref => {
    read.push(ref.id)
    return asGroupDetail({
      group: {
        kind: 'team',
        id: ref.id,
        name: 'Ravens',
        imageUrl: null,
        locality: null,
        startsOn: null,
        endsOn: null
      },
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      games: [],
      staff: [],
      canManage: true,
      nonMemberView: false,
      canViewPrivate: true
    })
  }
  return { client, read }
}

describe('GroupGameSchedule with an open side', () => {
  afterEach(unmount)

  it('names an open side TBD, reads only the named team, and links no team', async () => {
    const f = fixture([proposal('request-1', 'team-ravens', '')])
    await mount(
      <GroupGameSchedule
        client={f.client}
        groupRef={{ kind: 'team', id: 'team-ravens' }}
        onRequest={() => undefined}
      />
    )
    await settle()
    expect(text()).includes('TBD at Ravens')
    expect(f.read).deep.equals(['team-ravens'])
    expect(document.querySelectorAll('[role="link"], a[href]').length).equals(0)
  })

  it('names both sides TBD and reads no team when both are open', async () => {
    const f = fixture([proposal('request-2', '', '')])
    await mount(
      <GroupGameSchedule
        client={f.client}
        groupRef={{ kind: 'season', id: 'season-1' }}
        onRequest={() => undefined}
      />
    )
    await settle()
    expect(text()).includes('TBD at TBD')
    expect(f.read).deep.equals([])
  })
})
