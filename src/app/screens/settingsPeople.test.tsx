import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asInvite, asManagePage, TeamStationClient } from '../../common/api'
import { parseEmailList } from '../../common/emailList'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { AddPeopleScreen } from './AddPeopleScreen'
import { GroupLocationPage } from './GroupLocationPage'
import { GroupPeoplePage } from './GroupPeoplePage'
import { InvitationsWaiting } from './InvitationsWaiting'
import { InviteSpectatorsScreen } from './InviteSpectatorsScreen'
import { ParentOrganizations } from './ParentOrganizations'

const group = { kind: 'team' as const, id: 'bluebirds' }
function client(): TeamStationClient {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.roster = async () => []
  return api
}
function page(pending = true): ReturnType<typeof asManagePage> {
  return asManagePage({
    scope: { ...group, name: 'Bluebirds' },
    tree: { teams: [], seasons: [], leagues: [] },
    invites: [],
    pending: pending
      ? [
          {
            inviteId: 'invite_fixture',
            requestId: 'request_fixture',
            code: 'fixture-code',
            email: 'parent@example.test',
            invitedAt: '2027-03-01T00:00:00Z'
          }
        ]
      : [],
    people: [
      {
        userId: 101,
        displayName: 'Mookie Betts',
        emails: ['player@example.test'],
        player: true
      },
      { userId: 102, displayName: 'Aaron Judge', emails: [], player: true },
      { userId: 103, displayName: 'Babe Ruth', emails: [], player: false }
    ].map(row => ({
      ...row,
      teams: [
        {
          id: group.id,
          name: 'Bluebirds',
          role: 'member',
          isPlayer: row.player
        }
      ],
      seasons: [],
      leagues: [],
      adminOf: [],
      createdAt: '2027-03-01T00:00:00Z',
      lastSignInAt: null,
      lastSeenAt: null
    }))
  })
}
describe('settings people flows', function () {
  this.timeout(10000)
  afterEach(unmount)
  it('hides the previous group’s editable child screen while a new group is loading', async () => {
    for (const location of [true, false]) {
      const api = client()
      let finish: (() => void) | undefined
      api.group = async ref => {
        if (ref.id === 'next')
          await new Promise<void>(resolve => {
            finish = resolve
          })
        return asGroupDetail({
          group: { ...ref, name: 'Bluebirds', imageUrl: null, locality: null },
          parents: [],
          children: [],
          competingTeams: [],
          participatingSeasons: [],
          games: [],
          staff: [],
          canManage: ref.id !== 'next',
          nonMemberView: false,
          canViewPrivate: true
        })
      }
      let move: () => void = () => {}
      function Visit(): React.ReactElement {
        const [id, setId] = React.useState(group.id)
        move = () => {
          setId('next')
        }
        return location ? (
          <GroupLocationPage
            client={api}
            kind="team"
            id={id}
            onDone={() => {}}
          />
        ) : (
          <GroupPeoplePage
            client={api}
            group={{ ...group, id }}
            invites={false}
            onDone={() => {}}
          />
        )
      }
      await mount(<Visit />)
      expect(find(location ? 'Save' : 'Add people')).not.equals(undefined)
      await act(async () => {
        move()
      })
      expect(text()).includes('Loading…')
      expect(find('Save')).equals(undefined)
      expect(find('Add people')).equals(undefined)
      await act(async () => {
        finish!()
      })
      expect(text()).includes('Only a current administrator')
      await unmount()
    }
  })
  it('ignores parent-removal completion after leaving the settings visit', async () => {
    const api = client()
    let finish: (() => void) | undefined
    let left = 0
    api.parentPreview = async actions => ({
      actions,
      effects: actions,
      expected: {},
      explanation: ['Remove the parent relationship']
    })
    api.changeParents = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    const parent = asPublicGroup({
      kind: 'league',
      id: 'harbor',
      name: 'Harbor League',
      imageUrl: null,
      locality: null
    })
    await mount(
      <ParentOrganizations
        client={api}
        teamId={group.id}
        teamName="Bluebirds"
        parents={[parent]}
        onLeft={() => {
          left++
        }}
      />
    )
    await press('Leave Harbor League')
    await confirm('Leave Harbor League')
    expect(find('Cancel')?.getAttribute('aria-disabled')).equals('true')
    await unmount()
    await act(async () => {
      finish!()
    })
    expect(left).equals(0)
  })
  it('retries route loading, uses canonical groups and denies non-administrators', async () => {
    const api = client()
    let fail = true
    let allowed = true
    let cancelled = 0
    api.group = async () => {
      if (fail) throw new Error('Offline')
      return asGroupDetail({
        group: {
          ...group,
          id: 'canonical',
          name: 'Bluebirds',
          imageUrl: null,
          locality: null
        },
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        nonMemberView: false,
        canManage: allowed
      })
    }
    api.invites = async (kind, id) => {
      expect([kind, id]).deep.equals(['team', 'canonical'])
      return { canInvite: true, invites: [] }
    }
    for (const location of [false, true]) {
      fail = true
      await mount(
        location ? (
          <GroupLocationPage
            client={api}
            kind="team"
            id="alias"
            onDone={() => {
              cancelled++
            }}
          />
        ) : (
          <GroupPeoplePage
            client={api}
            group={{ ...group, id: 'alias' }}
            invites
            onDone={() => {
              cancelled++
            }}
          />
        )
      )
      expect(text()).includes('could not load')
      fail = false
      await press('Retry')
      await settle()
      expect(text()).includes(location ? 'CITY' : 'Invite Spectators')
      await unmount()
      allowed = false
      await mount(
        location ? (
          <GroupLocationPage
            client={api}
            kind="team"
            id="alias"
            onDone={() => {
              cancelled++
            }}
          />
        ) : (
          <GroupPeoplePage
            client={api}
            group={group}
            invites={false}
            onDone={() => {
              cancelled++
            }}
          />
        )
      )
      expect(text()).includes('Only a current administrator')
      await press('Cancel')
      await unmount()
      allowed = true
    }
    expect(cancelled).equals(2)
    await mount(
      <GroupPeoplePage
        client={api}
        group={group}
        invites={false}
        onDone={() => {
          cancelled++
        }}
      />
    )
    expect(text()).includes('Add People')
    await press('Cancel')
    expect(cancelled).equals(3)
  })
  it('recovers spectator link loading and mutation failures and hides controls on denial', async () => {
    const api = client()
    let fail = true
    let allowed = true
    api.invites = async () => {
      if (fail) throw new Error('Offline')
      return { canInvite: allowed, invites: [] }
    }
    api.createInvite = async () => {
      throw new Error('Cannot create yet')
    }
    await mount(
      <InviteSpectatorsScreen
        client={api}
        group={group}
        scopeName="Bluebirds"
      />
    )
    expect(text()).includes('Invite links could not load')
    fail = false
    await press('Retry')
    await settle()
    await press('Create invite link')
    await press('Create')
    expect(text()).includes('Cannot create yet')
    await unmount()
    allowed = false
    await mount(
      <InviteSpectatorsScreen
        client={api}
        group={group}
        scopeName="Bluebirds"
      />
    )
    expect(text()).includes('Only an administrator')
    expect(find('Create invite link')).equals(undefined)
  })
  it('normalizes and deduplicates addresses, preserving invalid entries', () => {
    expect(
      parseEmailList(
        ' Player@Example.test,player@example.test; bad\nother@example.test'
      )
    ).deep.equals({
      valid: ['player@example.test', 'other@example.test'],
      invalid: ['bad']
    })
  })
  it('retains only failed addresses and reuses their idempotency keys on retry', async () => {
    const api = client()
    const calls: Array<{ email: string; key: string | undefined }> = []
    let fail = true
    let done = 0
    api.addPerson = async (_kind, _id, email, options) => {
      calls.push({ email, key: options?.idempotencyKey })
      if (email === 'failed@example.test' && fail)
        throw new Error('Delivery unavailable')
      return {
        added: true,
        person: { userId: 101, displayName: 'Mookie Betts', email },
        invited: undefined
      }
    }
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Bluebirds"
        onDone={() => {
          done++
        }}
        onCancel={() => {}}
      />
    )
    await fill('E-mail addresses', 'added@example.test,failed@example.test')
    await press('Add people')
    expect(text())
      .includes('Added 1, invited 0, 1 failed')
      .and.includes('Delivery unavailable')
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="E-mail addresses"]'
      )!.value
    ).equals('failed@example.test')
    fail = false
    await press('Add people')
    expect(done).equals(1)
    expect(calls[2].key).equals(calls[1].key)
    expect(calls.filter(row => row.email === 'added@example.test')).length(1)
  })
  it('prevents mixed-invalid submission and cancels without sending', async () => {
    const api = client()
    let cancelled = false
    api.addPerson = async () => {
      throw new Error('Must not send')
    }
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Bluebirds"
        onDone={() => {}}
        onCancel={() => {
          cancelled = true
        }}
      />
    )
    await fill('E-mail addresses', 'valid@example.test,invalid')
    expect(find('Add people')?.getAttribute('aria-disabled')).equals('true')
    await press('Cancel')
    expect(cancelled).equals(true)
  })
  it('puts Resend above Withdraw, refreshes withdrawal, and lists all roster players', async () => {
    const api = client()
    let pending = true
    const calls: unknown[] = []
    api.managePage = async () => page(pending)
    api.decideRelationship = async (id, action) => {
      calls.push([id, action])
      return { id, status: 'pending' }
    }
    api.revokeInvite = async id => {
      calls.push(id)
      pending = false
    }
    await mount(
      <InvitationsWaiting client={api} scopeKind="team" scopeId={group.id} />
    )
    expect(text())
      .includes('Mookie Betts')
      .and.includes('Aaron Judge')
      .and.not.includes('Babe Ruth')
    expect(find('Open')).equals(undefined)
    const resend = find('Resend invitation to parent@example.test')!
    expect(
      resend.compareDocumentPosition(
        find('Withdraw invitation to parent@example.test')!
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    await press('Resend invitation to parent@example.test')
    expect(text()).includes('Sent again')
    await press('Withdraw invitation to parent@example.test')
    await press('Confirm withdrawal')
    await settle()
    expect(text()).not.includes('INVITATIONS WAITING')
    expect(calls).deep.equals([['request_fixture', 'resend'], 'invite_fixture'])
  })
  it('confirms player removal, retains errors, and cancel makes no write', async () => {
    const api = client()
    let removed = 0
    let fail = true
    api.managePage = async () => page(false)
    api.removePerson = async (_kind, _id, user) => {
      expect(user).equals(102)
      if (fail) throw new Error('Removal unavailable')
      removed++
      return { removed: true }
    }
    await mount(
      <InvitationsWaiting client={api} scopeKind="team" scopeId={group.id} />
    )
    await press('Remove Aaron Judge')
    expect(text()).includes('Remove Aaron Judge from Bluebirds?')
    await press('Cancel')
    expect(removed).equals(0)
    await press('Remove Aaron Judge')
    await confirm('Remove Aaron Judge')
    expect(text()).includes('Removal unavailable')
    fail = false
    await confirm('Remove Aaron Judge')
    expect(removed).equals(1)
  })
  it('shows active spectator links, creates and disables them', async () => {
    const api = client()
    let active = true
    let created = 0
    const invite = asInvite({
      id: 'link_fixture',
      code: 'fixture-code',
      url: 'https://example.test/join/fixture-code',
      scopeType: 'team',
      scopeId: group.id,
      label: 'Families',
      uses: 2,
      maxUses: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: '2027-03-01T00:00:00Z',
      problem: null
    })
    api.invites = async () => ({
      canInvite: true,
      invites: active ? [invite] : []
    })
    api.createInvite = async () => {
      created++
      return invite
    }
    api.revokeInvite = async () => {
      active = false
    }
    await mount(
      <InviteSpectatorsScreen
        client={api}
        group={group}
        scopeName="Bluebirds"
      />
    )
    expect(text()).includes('Used 2 times · Families')
    await press('Create invite link')
    await press('Cancel')
    expect(created).equals(0)
    await press('Create invite link')
    await fill('Label', 'Families')
    await press('Create')
    expect(created).equals(1)
    await press('Disable invite link Families')
    expect(text()).includes('Disable Families for Bluebirds?')
    await press('Cancel')
    expect(active).equals(true)
    await press('Disable invite link Families')
    await press('Confirm disable')
    await settle()
    expect(text()).includes('No invite links yet.')
  })
  it('reviews leaving a parent, cancels without writes, and retries confirmation errors', async () => {
    const api = client()
    let writes = 0
    let left = 0
    let fail = true
    api.parentPreview = async actions => ({
      actions,
      effects: actions,
      expected: {},
      explanation: ['Remove the Bluebirds from Harbor League']
    })
    api.changeParents = async () => {
      if (fail) throw new Error('Relationship changed. Retry.')
      writes++
    }
    const parent = asPublicGroup({
      kind: 'league',
      id: 'harbor',
      name: 'Harbor League',
      imageUrl: null,
      locality: null
    })
    await mount(
      <ParentOrganizations
        client={api}
        teamId={group.id}
        teamName="Bluebirds"
        parents={[parent]}
        onLeft={() => {
          left++
        }}
      />
    )
    await press('Leave Harbor League')
    expect(text()).includes('will no longer manage Bluebirds')
    await press('Cancel')
    expect(writes).equals(0)
    await press('Leave Harbor League')
    await confirm('Leave Harbor League')
    expect(text()).includes('Relationship changed. Retry.')
    fail = false
    await confirm('Leave Harbor League')
    expect(writes).equals(1)
    expect(left).equals(1)
  })
})

async function confirm(label: string): Promise<void> {
  const nodes = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].filter(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  await act(async () => {
    nodes.at(-1)!.click()
  })
  await settle(0)
}
