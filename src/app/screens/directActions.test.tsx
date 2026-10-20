import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'

import { asAccountSettings } from '../../common/accountSettings'
import { asAddedPerson, TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
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
import { GroupLinkScreen } from './GroupLinkScreen'
import { GroupPeoplePage } from './GroupPeoplePage'
import { PromoteExternalScreen } from './PromoteExternalScreen'

const source = { kind: 'season' as const, id: 'season_demo' }
const target = asPublicGroup({
  kind: 'team',
  id: 'team_demo',
  name: 'Demo Visitors',
  imageUrl: null,
  locality: null
})
function fixture(): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.ownGroups = async () => [target]
  client.group = async ref => detail(ref)
  client.parentPreview = async actions => ({
    actions,
    effects: actions,
    expected: {},
    explanation: []
  })
  client.accountSettings = async () =>
    asAccountSettings({
      user: {
        id: userIdOfGumbo(101),
        displayName: 'Babe Ruth',
        avatarUrl: null,
        isAdmin: false
      },
      emails: [
        {
          id: 'email_demo',
          email: 'admin@example.test',
          isPrimary: true,
          isVerified: true
        },
        {
          id: 'email_imported',
          email: 'imported@example.test',
          isPrimary: false,
          isVerified: false
        }
      ],
      hasPassword: false
    })
  return client
}
function detail(
  ref: GroupRef,
  allowed = true
): ReturnType<typeof asGroupDetail> {
  return asGroupDetail({
    group: {
      ...ref,
      name: ref.kind === 'team' ? target.name : 'Demo Season',
      imageUrl: null,
      locality: null
    },
    nonMemberView: false,
    parents: [],
    children: [],
    competingTeams: [],
    participatingSeasons: [],
    games: [],
    staff: [],
    canManage: allowed
  })
}
describe('direct action request forms', () => {
  afterEach(unmount)
  it('cancels an unavailable people page without a completion notice', async () => {
    const api = fixture()
    api.group = async () => {
      throw new Error('Group unavailable')
    }
    let cancelled = false
    let notice: string | undefined
    await mount(
      <GroupPeoplePage
        client={api}
        group={source}
        invites={false}
        onDone={message => {
          cancelled = true
          notice = message
        }}
      />
    )
    await press('Cancel')
    expect(cancelled).equals(true)
    expect(notice).equals(undefined)
  })
  for (const relationship of ['parent', 'participation'] as const)
    for (const allowed of [false, true])
      it(`${relationship} ${allowed ? 'Save supplies all available consent' : 'invitation still needs the other side'}`, async () => {
        const api = fixture()
        api.group = async ref => detail(ref, ref.kind !== 'team' || allowed)
        const calls: Array<
          Parameters<TeamStationClient['inviteRelationship']>[0]
        > = []
        let completed: unknown
        api.inviteRelationship = async body => {
          calls.push(body)
          return {
            id: 'request_demo',
            status: allowed ? 'accepted' : 'pending'
          }
        }
        await mount(
          <GroupLinkScreen
            client={api}
            choice={{
              subject: source,
              targetKind: 'team',
              relationship,
              direction: 'children'
            }}
            onSent={(id, result) => {
              completed = { id, ...result }
            }}
            onCancel={() => {}}
          />
        )
        await press('Choose Demo Visitors')
        expect(find('I approve for all affected groups')).equals(undefined)
        await press(allowed ? 'Save' : 'Send invitation')
        expect('confirmBoth' in calls[0] && calls[0].confirmBoth).equals(
          allowed
        )
        expect(completed).includes({
          id: 'request_demo',
          status: allowed ? 'accepted' : 'pending'
        })
        expect((completed as { message: string }).message)
          .includes('Demo Visitors')
          .and.includes('Demo Season')
      })
  it('checks every explicit parent-batch endpoint and allows either side of a removal', async () => {
    const api = fixture()
    let thirdAllowed = false
    api.parentPreview = async actions => ({
      actions: [
        ...actions,
        {
          operation: 'detach',
          parent: source,
          child: { kind: 'team', id: 'old_team' }
        },
        {
          operation: 'attach',
          parent: { kind: 'league', id: 'third' },
          child: { kind: 'team', id: target.id }
        }
      ],
      effects: actions,
      expected: {},
      explanation: []
    })
    api.group = async ref =>
      detail(ref, ref.id !== 'old_team' && (ref.id !== 'third' || thirdAllowed))
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: source,
          targetKind: 'team',
          relationship: 'parent',
          direction: 'children'
        }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Visitors')
    expect(find('Send invitation')).not.equals(undefined)
    thirdAllowed = true
    await press('Review all parent changes')
    expect(find('Save')).not.equals(undefined)
  })
  it('saves a removals-only parent batch through the direct endpoint without an invitation', async () => {
    const api = fixture()
    api.parentPreview = async actions => ({
      actions: actions.map(action => ({
        ...action,
        operation: 'detach' as const
      })),
      effects: actions.map(action => ({
        ...action,
        operation: 'detach' as const
      })),
      expected: {},
      explanation: []
    })
    let changes = 0
    let completed: unknown
    api.changeParents = async preview => {
      changes++
      expect(preview.actions[0].operation).equals('detach')
    }
    api.inviteRelationship = async () => {
      throw new Error('A removal has no invited side')
    }
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: source,
          targetKind: 'team',
          relationship: 'parent',
          direction: 'children'
        }}
        onSent={(_id, result) => {
          completed = result
        }}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Visitors')
    await press('Save')
    expect(changes).equals(1)
    expect(completed).includes({ status: 'accepted' })
    expect((completed as { message: string }).message).includes(
      'removed as parent'
    )
  })
  for (const changed of [true, false])
    it(`describes ${changed ? 'implied parent effects rather than explicit no-ops' : 'a no-op without claiming a connection changed'}`, async () => {
      const api = fixture()
      api.parentPreview = async actions => ({
        actions,
        effects: changed
          ? [
              {
                operation: 'detach',
                parent: source,
                child: { kind: 'team', id: 'implied' }
              }
            ]
          : [],
        expected: {},
        explanation: []
      })
      api.group = async ref => {
        const row = detail(ref, ref.id !== 'implied')
        if (ref.id === 'implied') row.group.name = 'Demo Implied Team'
        return row
      }
      api.inviteRelationship = async body => {
        expect('confirmBoth' in body && body.confirmBoth).equals(true)
        return { id: 'request_demo', status: 'accepted' }
      }
      let notice = ''
      await mount(
        <GroupLinkScreen
          client={api}
          choice={{
            subject: source,
            targetKind: 'team',
            relationship: 'parent',
            direction: 'children'
          }}
          onSent={(_id, result) => {
            notice = result?.message ?? ''
          }}
          onCancel={() => {}}
        />
      )
      await press('Choose Demo Visitors')
      await press('Save')
      expect(notice).equals(
        changed
          ? 'Demo Season removed as parent of Demo Implied Team'
          : 'No management connections changed'
      )
    })
  it('keeps Save retryable, suppresses duplicate submission and ignores completion after unmount', async () => {
    const api = fixture()
    let finish!: (value: { id: string; status: string }) => void
    let calls = 0
    let completed = false
    api.inviteRelationship = async () => {
      calls++
      return await new Promise(resolve => {
        finish = resolve
      })
    }
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: source,
          targetKind: 'team',
          relationship: 'participation',
          direction: 'children'
        }}
        onSent={() => {
          completed = true
        }}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Visitors')
    const save = find('Save')!
    await act(async () => {
      save.click()
      save.click()
    })
    expect(calls).equals(1)
    await unmount()
    await act(async () => {
      finish({ id: 'request_demo', status: 'accepted' })
    })
    expect(completed).equals(false)
  })
  it('fails closed on group lookup failure and can choose a new group after retry', async () => {
    const api = fixture()
    api.group = async () => {
      throw new Error('Rights unavailable')
    }
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: source,
          targetKind: 'team',
          relationship: 'participation',
          direction: 'children'
        }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Visitors')
    expect(text()).includes('Rights unavailable')
    expect(find('Save')).equals(undefined)
    await press('Choose another group')
    api.group = async ref => detail(ref)
    await press('Choose Demo Visitors')
    expect(find('Save')).not.equals(undefined)
  })
  it('ignores an older authority response after the source identity changes', async () => {
    const api = fixture()
    let finish!: (value: ReturnType<typeof asGroupDetail>) => void
    api.group = async ref =>
      ref.id === source.id
        ? await new Promise(resolve => {
            finish = resolve
          })
        : detail(ref)
    let move!: () => void
    function Scene(): React.ReactElement {
      const [id, setId] = useState(source.id)
      move = () => {
        setId('another_season')
      }
      return (
        <GroupLinkScreen
          client={api}
          choice={{
            subject: { ...source, id },
            targetKind: 'team',
            relationship: 'participation',
            direction: 'children'
          }}
          onSent={() => {
            throw new Error('No stale completion expected')
          }}
          onCancel={() => {}}
        />
      )
    }
    await mount(<Scene />)
    await press('Choose Demo Visitors')
    await act(async () => {
      move()
    })
    await settle()
    await act(async () => {
      finish(detail(source))
    })
    expect(find('Save')).equals(undefined)
    expect(find('Choose Demo Visitors')).not.equals(undefined)
  })
  it('ignores a rejected manual review after the source identity changes', async () => {
    const api = fixture()
    let rejectOld!: (error: Error) => void
    let previews = 0
    api.parentPreview = async actions => {
      if (++previews === 2)
        return await new Promise((_resolve, reject) => {
          rejectOld = reject
        })
      return { actions, effects: actions, expected: {}, explanation: [] }
    }
    let move!: () => void
    function Scene(): React.ReactElement {
      const [id, setId] = useState(source.id)
      move = () => {
        setId('another_season')
      }
      return (
        <GroupLinkScreen
          client={api}
          choice={{
            subject: { ...source, id },
            targetKind: 'team',
            relationship: 'parent',
            direction: 'children'
          }}
          onSent={() => {}}
          onCancel={() => {}}
        />
      )
    }
    await mount(<Scene />)
    await press('Choose Demo Visitors')
    await press('Review all parent changes')
    await act(async () => {
      move()
    })
    await settle()
    // Begin work on the new screen before the old request settles. Its finally
    // handler must not unlock the new request's pending action either.
    let finishNew!: (value: ReturnType<typeof asGroupDetail>) => void
    api.group = async ref =>
      ref.id === 'another_season'
        ? await new Promise(resolve => {
            finishNew = resolve
          })
        : detail(ref)
    await press('Choose Demo Visitors')
    await act(async () => {
      rejectOld(new Error('Old season review rejected'))
    })
    expect(text()).not.includes('Old season review rejected')
    expect(find('Choose another group')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    api.group = async ref => detail(ref)
    await act(async () => {
      finishNew(detail({ ...source, id: 'another_season' }))
    })
    expect(find('Save')).not.equals(undefined)
  })
  for (const email of [
    'ADMIN@example.test',
    'other@example.test',
    'imported@example.test'
  ])
    it(`labels promotion to ${email.startsWith('ADMIN') ? 'the current verified account' : 'another person'} truthfully and keeps the server result`, async () => {
      const api = fixture()
      let sent:
        Parameters<TeamStationClient['inviteRelationship']>[0] | undefined
      let result: unknown
      api.inviteRelationship = async body => {
        sent = body
        return { id: 'promotion_demo', status: 'pending' }
      }
      await mount(
        <PromoteExternalScreen
          client={api}
          teamId={target.id}
          onSent={(_id, value) => {
            result = value
          }}
          onCancel={() => {}}
        />
      )
      await fill('Administrator email', email)
      await press(
        email.startsWith('ADMIN') ? 'Save' : 'Send administrator invitation'
      )
      expect(sent != null && 'confirmBoth' in sent && sent.confirmBoth).equals(
        email.startsWith('ADMIN')
      )
      expect(result).includes({ status: 'pending' })
      expect((result as { message: string }).message)
        .includes(target.name)
        .and.includes(email)
    })
  for (const kinds of [
    [true, true],
    [false, false],
    [true, false]
  ])
    it(`reports actual Add people outcomes ${kinds.join(',')}`, async () => {
      const api = fixture()
      let index = 0
      let notice = ''
      api.addPerson = async (_kind, _id, email) =>
        asAddedPerson(
          kinds[index++]
            ? {
                added: true,
                person: {
                  userId: userIdOfGumbo(102),
                  displayName: 'Lou Gehrig',
                  email
                }
              }
            : {
                added: false,
                invited: {
                  inviteId: 'invite_demo',
                  code: 'synthetic-fixture-code',
                  email,
                  invitedAt: '2027-04-10T19:00:00Z'
                }
              }
        )
      await mount(
        <AddPeopleScreen
          client={api}
          group={source}
          scopeName="Demo Season"
          onDone={message => {
            notice = message ?? ''
          }}
          onCancel={() => {}}
        />
      )
      await fill('E-mail addresses', 'first@example.test,second@example.test')
      await press('Add people')
      expect(notice)
        .includes('Demo Season')
        .and.includes('first@example.test')
        .and.includes('second@example.test')
      expect(notice).includes(
        `Added ${kinds.filter(Boolean).length}, invited ${kinds.filter(value => !value).length}`
      )
    })
  it('does not send or show success when canceled', async () => {
    const api = fixture()
    let canceled = false
    await mount(
      <PromoteExternalScreen
        client={api}
        teamId={target.id}
        onSent={() => {
          throw new Error('No success expected')
        }}
        onCancel={() => {
          canceled = true
        }}
      />
    )
    await press('Cancel')
    expect(canceled).equals(true)
    await settle(0)
  })
})
