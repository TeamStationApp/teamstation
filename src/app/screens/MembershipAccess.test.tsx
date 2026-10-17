import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { TeamStationClient } from '../../common/api'
import { asGroupDetail } from '../../common/publicGroups'
import { find, mount, press, text, unmount } from '../../test/gameFormDom'
import { MembershipAccess } from './MembershipAccess'

const teams = [
  { id: 'owls', name: 'Demo Owls' },
  { id: 'hawks', name: 'Demo Hawks' }
]
function client(external = false): TeamStationClient {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.group = async ref =>
    asGroupDetail({
      group: {
        ...teams.find(team => team.id === ref.id),
        kind: 'team',
        external,
        imageUrl: null,
        locality: null
      },
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      nonMemberView: true,
      canManage: false
    })
  return api
}

describe('membership access requests', () => {
  afterEach(unmount)

  it('requires a team choice, retries the same request, and closes the successful video warning', async () => {
    const api = client()
    const requests: unknown[] = []
    api.inviteRelationship = async request => {
      requests.push(request)
      if (requests.length === 1) throw new Error('Please retry')
      return { id: 'request-demo', status: 'pending' }
    }
    let closed = 0
    await mount(
      <MembershipAccess
        client={api}
        signedIn
        teams={teams}
        resource="videos"
        presentation="sheet"
        onSignIn={() => undefined}
        onClose={() => {
          closed++
        }}
      />
    )
    await press('Request membership')
    await press('Send request')
    expect(text()).includes('Choose the team you want to join.')
    expect(requests).length(0)
    await press('Demo Hawks')
    await press('Send request')
    expect(text()).includes('Please retry')
    await press('Send request')
    expect(requests).length(2)
    expect(requests[1]).deep.equals(requests[0])
    expect(requests[0]).includes({ kind: 'membership', teamId: 'hawks' })
    expect(text()).includes('Membership request sent')
    expect(text()).includes('Videos become available after approval.')
    await press('Done')
    expect(closed).equals(1)
  })

  it('selects the only available team and replaces the inline stats action with confirmation', async () => {
    const api = client()
    let selected: unknown
    api.inviteRelationship = async request => {
      selected = request
      return { id: 'request-demo', status: 'pending' }
    }
    await mount(
      <MembershipAccess
        client={api}
        signedIn
        teams={teams.slice(0, 1)}
        onSignIn={() => undefined}
      />
    )
    expect(text()).includes('this team to see individual player stats')
    await press('Request membership')
    await press('Send request')
    expect(selected).includes({ teamId: 'owls' })
    expect(text()).includes(
      'Individual player stats become available after approval.'
    )
    expect(find('Send request')).equals(undefined)
  })

  it('keeps failed group lookups retryable and refuses teams that cannot accept requests', async () => {
    const api = client(true)
    const group = api.group.bind(api)
    let attempts = 0
    api.group = async ref => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an untyped transport rejection.
      if (++attempts === 1) throw 'offline'
      return await group(ref)
    }
    await mount(
      <MembershipAccess
        client={api}
        signedIn
        teams={teams.slice(0, 1)}
        onSignIn={() => undefined}
      />
    )
    await press('Request membership')
    expect(text()).includes('The request could not be sent. Please try again.')
    await press('Request membership')
    expect(text()).includes(
      'These teams do not accept membership requests yet.'
    )
    expect(find('Send request')).equals(undefined)
  })

  it('closes the warning before taking a guest to sign in', async () => {
    const actions: string[] = []
    await mount(
      <MembershipAccess
        client={client()}
        signedIn={false}
        teams={teams}
        presentation="sheet"
        onClose={() => {
          actions.push('close')
        }}
        onSignIn={() => {
          actions.push('signIn')
        }}
      />
    )
    expect(text()).includes(
      'Log in or create an account first to request membership.'
    )
    await press('Log in / Sign up')
    expect(actions).deep.equals(['close', 'signIn'])
  })
})
