import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asInvite,
  asManagePage,
  asPersonProfile,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { find, press, settle, text } from '../../test/gameFormDom'
import { RoleRows } from '../components/RoleRows'
import { ThemeProvider } from '../theme/ThemeContext'
import { InvitationsWaiting } from './InvitationsWaiting'
import { InviteSpectatorsScreen } from './InviteSpectatorsScreen'
import { PersonProfileScreen } from './PersonProfileScreen'
import { PlayerTeamRoles } from './PlayerTeamRoles'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  await settle(0)
}
const group = { kind: 'team' as const, id: 'team' }
const invite = asInvite({
  id: 'link',
  code: 'demo-link',
  url: 'https://example.test/join/demo-link',
  label: null,
  scopeType: 'team',
  scopeId: 'team',
  invitedBy: 'Babe Ruth',
  uses: 0,
  maxUses: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2027-01-01T00:00:00Z',
  problem: null
})
function page(pending = true): ReturnType<typeof asManagePage> {
  return asManagePage({
    scope: { ...group, name: 'Demo Team' },
    tree: { teams: [], seasons: [], leagues: [] },
    invites: [],
    pending: pending
      ? [
          {
            inviteId: 'invite',
            requestId: 'request',
            code: 'demo-pending',
            email: 'pending@example.com',
            invitedAt: '2027-01-01T00:00:00Z'
          }
        ]
      : [],
    people: []
  })
}
describe('relationship list access regression', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  for (const player of [false, true]) {
    for (const unavailable of [false, true]) {
      it(`closes successful ${player ? 'player role' : 'final membership'} removal when refresh ${unavailable ? 'returns notFound' : 'fails, with read-only retry'}`, async () => {
        const api = new TeamStationClient({ baseUrl: '/api/v1' })
        let writes = 0
        let reads = 0
        let notices = 0
        api.personProfile = async () => {
          reads++
          if (reads === 2)
            throw unavailable
              ? new HttpError('notFound', 'Not found')
              : new Error('Read unavailable')
          return asPersonProfile({
            context: { kind: 'team', id: 'team', name: 'Demo Team' },
            person: {
              userId: 104,
              gumboId: 104,
              shortName: 'Ichiro',
              fullName: 'Ichiro',
              avatarUrl: null,
              canHoldRoles: true
            },
            guardianOf: [],
            sections: [
              {
                level: 'team',
                groups: [{ id: 'team', name: 'Demo Team' }],
                roles: player && writes === 0 ? ['coach'] : [],
                member: writes === 0,
                follower: false,
                editable: true
              }
            ],
            viewer: { manages: true, admin: true }
          })
        }
        api.removeRole = async (_kind, _id, _userId, role) => {
          expect(role).equals(player ? 'coach' : 'member')
          writes++
          return { userId: 104, roles: [], member: false }
        }
        await render(
          player ? (
            <PlayerTeamRoles client={api} teamId="team" userId={104} />
          ) : (
            <PersonProfileScreen
              client={api}
              kind="team"
              id="team"
              userId={104}
              onChanged={() => notices++}
            />
          )
        )
        await press(player ? 'Coach' : 'Member')
        await press('Confirm removal')
        expect(writes).equals(1)
        expect(reads).equals(2)
        expect(notices).equals(player ? 0 : 1)
        expect(find('Confirm removal')).equals(undefined)
        expect(text()).includes('Change saved.')
        expect(document.querySelector('[role="switch"]')).equals(null)
        if (unavailable) {
          expect(text()).not.includes('Not found')
          expect(find('Retry')).equals(undefined)
        } else {
          expect(text()).includes('Read unavailable')
          await press('Retry')
          expect(reads).equals(3)
          expect(writes).equals(1)
          expect(text()).not.includes('Read unavailable')
          expect(find('Confirm removal')).equals(undefined)
        }
      })
    }
  }
  it('confirms disabling the named link, guards duplicate writes and leaves failures retryable', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.invites = async () => ({ canInvite: true, invites: [invite] })
    let writes = 0
    let fail = true
    let finish!: () => void
    api.revokeInvite = async id => {
      expect(id).equals('link')
      writes++
      if (fail) throw new Error('Disable unavailable')
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    await render(
      <InviteSpectatorsScreen
        client={api}
        group={group}
        scopeName="Demo Team"
      />
    )
    await press('Disable invite link demo-link')
    expect(writes).equals(0)
    expect(text()).includes('Disable demo-link for Demo Team?')
    await press('Cancel')
    expect(writes).equals(0)
    await press('Disable invite link demo-link')
    await press('Confirm disable')
    expect(text()).includes('Disable unavailable')
    fail = false
    await act(async () => {
      find('Confirm disable')!.click()
      find('Confirm disable')!.click()
    })
    expect(writes).equals(2)
    await press('Cancel')
    expect(find('Cancel')?.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      finish()
    })
    expect(find('Confirm disable')).equals(undefined)
  })
  it('drops a previous link selection and ignores its completion on a different group', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    let loads = 0
    let finish!: () => void
    api.invites = async () => {
      loads++
      return { canInvite: true, invites: [invite] }
    }
    api.revokeInvite = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    await render(
      <InviteSpectatorsScreen
        client={api}
        group={group}
        scopeName="Demo Team"
      />
    )
    await press('Disable invite link demo-link')
    await press('Confirm disable')
    await render(
      <InviteSpectatorsScreen
        client={api}
        group={{ kind: 'season', id: 'new' }}
        scopeName="Demo Season"
      />
    )
    const count = loads
    await act(async () => {
      finish()
    })
    expect(loads).equals(count)
    expect(find('Confirm disable')).equals(undefined)
  })
  it('keeps Withdraw failures in its named modal and refreshes only after confirmation', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.roster = async () => []
    let pending = true
    let changes = 0
    let fail = true
    api.managePage = async () => page(pending)
    api.revokeInvite = async id => {
      expect(id).equals('invite')
      if (fail) throw new Error('Withdraw unavailable')
      pending = false
    }
    await render(
      <InvitationsWaiting
        client={api}
        scopeKind="team"
        scopeId="team"
        onChanged={() => changes++}
      />
    )
    await press('Withdraw invitation to pending@example.com')
    await press('Cancel confirmation')
    expect(changes).equals(0)
    await press('Withdraw invitation to pending@example.com')
    await press('Confirm withdrawal')
    expect(text()).includes('Withdraw unavailable')
    expect(changes).equals(0)
    fail = false
    await press('Confirm withdrawal')
    await settle(0)
    expect(changes).equals(1)
    expect(find('Withdraw invitation to pending@example.com')).equals(undefined)
  })
  it('retries a failed Resend under the same key and ignores late writes from the previous scope', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.roster = async () => []
    api.managePage = async () => page()
    const keys: Array<string | undefined> = []
    let fail = true
    let finish!: () => void
    let changes = 0
    api.decideRelationship = async (id, action, key) => {
      keys.push(key)
      if (fail) throw new Error('Resend unavailable')
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return { id, status: 'pending' }
    }
    await render(
      <InvitationsWaiting
        client={api}
        scopeKind="team"
        scopeId="team"
        onChanged={() => changes++}
      />
    )
    await press('Resend invitation to pending@example.com')
    expect(text()).includes('Resend unavailable')
    fail = false
    await press('Resend invitation to pending@example.com')
    expect(keys).length(2)
    expect(keys[0]).equals(keys[1])
    await render(
      <InvitationsWaiting
        client={api}
        scopeKind="season"
        scopeId="next"
        onChanged={() => changes++}
      />
    )
    await act(async () => {
      finish()
    })
    expect(changes).equals(0)
    expect(text()).not.includes('Sent again')
  })
  it('role removal identifies the person and group, cancels without a write and retries refusal', async () => {
    let removals = 0
    let fail = true
    const props = {
      section: {
        level: 'team' as const,
        groups: [{ id: 'team', name: 'Demo Team' }],
        roles: [],
        member: true,
        follower: false,
        editable: true
      },
      viewer: { manages: true, admin: true },
      canHoldRoles: true
    }
    await render(
      <RoleRows
        {...props}
        ownerLabel="Babe Ruth"
        ownerIdentity="person:101"
        onAdd={() => {}}
        onRemove={async role => {
          expect(role).equals('member')
          if (fail) throw new Error('Removal refused')
          removals++
        }}
      />
    )
    await press('Member')
    expect(text()).includes('Remove Member from Babe Ruth?')
    expect(text()).includes('lose every role')
    await press('Cancel')
    expect(removals).equals(0)
    await press('Member')
    await press('Confirm removal')
    expect(text()).includes('Removal refused')
    fail = false
    await press('Confirm removal')
    expect(removals).equals(1)
  })
})
