import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asManagePage, TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
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
import { GroupSettingsScreen } from './GroupSettingsScreen'

function fixture(kind: GroupRef['kind'] = 'team'): {
  client: TeamStationClient
  calls: unknown[]
  controls: { fail: boolean; allowed: boolean }
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const calls: unknown[] = []
  const controls = { fail: false, allowed: true }
  let group = asGroupDetail({
    group: {
      kind,
      id: 'canonical',
      name: 'Bluebirds',
      imageUrl: null,
      locality:
        kind === 'season'
          ? null
          : {
              city: 'Toronto',
              region: 'Ontario',
              country: 'Canada',
              placeId: null,
              timezone: 'America/Toronto'
            },
      startsOn: kind === 'season' ? '2027-03-01' : null,
      endsOn: kind === 'season' ? '2027-05-31' : null
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
  client.group = async () => {
    if (controls.fail) throw new Error('Settings unavailable')
    return { ...group, canManage: controls.allowed }
  }
  client.managePage = async (asked, id) =>
    asManagePage({
      scope: { kind: asked, id, name: 'Bluebirds' },
      tree: { leagues: [], seasons: [], teams: [] },
      people: [],
      pending: [],
      invites: []
    })
  client.roster = async () => []
  client.gameProposals = async () => []
  client.updateGroup = async (ref, body) => {
    calls.push([ref, body])
    if (controls.fail) throw new Error('Save unavailable')
    group = {
      ...group,
      group: {
        ...group.group,
        ...body,
        imageUrl:
          body.picture == null
            ? group.group.imageUrl
            : 'https://images.example.test/group.png'
      }
    }
    return group.group
  }
  return { client, calls, controls }
}

describe('group settings identity and individual saves', () => {
  afterEach(unmount)
  it('releases an invalidated name save when a parent removal refreshes the same group', async () => {
    const f = fixture()
    const own = await f.client.group({ kind: 'team', id: 'canonical' })
    let removed = false
    f.client.group = async () => ({
      ...own,
      parents: removed
        ? []
        : [
            asPublicGroup({
              kind: 'league',
              id: 'harbor',
              name: 'Harbor League',
              imageUrl: null,
              locality: null
            })
          ]
    })
    f.client.parentPreview = async actions => ({
      actions,
      effects: actions,
      expected: {},
      explanation: []
    })
    f.client.changeParents = async () => {
      removed = true
    }
    let finish: (() => void) | undefined
    f.client.updateGroup = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return own.group
    }
    await mount(
      <GroupSettingsScreen
        client={f.client}
        groupRef={{ kind: 'team', id: 'canonical' }}
      />
    )
    await fill('Name', 'Wrens')
    await press('Save name')
    await press('Leave Harbor League')
    await act(async () => {
      const confirm = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ]
        .filter(
          node =>
            (node.getAttribute('aria-label') ?? node.textContent) ===
            'Leave Harbor League'
        )
        .at(-1)
      expect(confirm).not.equals(undefined)
      confirm!.click()
    })
    await settle()
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Name"]')!.disabled
    ).equals(false)
    expect(find('Save name')!.getAttribute('aria-disabled')).not.equals('true')
    await act(async () => {
      finish!()
    })
    expect(text()).not.includes('Name saved')
  })
  it('loads a new visit instead of carrying its predecessor’s draft or pending save', async () => {
    const f = fixture()
    const original = await f.client.group({ kind: 'team', id: 'canonical' })
    f.client.group = async ref => ({
      ...original,
      group: {
        ...original.group,
        kind: ref.kind,
        id: ref.id,
        name: ref.id === 'first' ? 'Bluebirds' : 'Wrens'
      }
    })
    let finish: (() => void) | undefined
    f.client.updateGroup = async ref => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return (await f.client.group(ref)).group
    }
    let visit: (ref: GroupRef) => void = () => {}
    function Visit(): React.ReactElement {
      const [ref, setRef] = React.useState<GroupRef>({
        kind: 'team',
        id: 'first'
      })
      visit = setRef
      return <GroupSettingsScreen client={f.client} groupRef={ref} />
    }
    await mount(<Visit />)
    await fill('Name', 'Unsaved Bluebirds')
    await press('Save name')
    await act(async () => {
      visit({ kind: 'league', id: 'second' })
    })
    await settle()
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value
    ).equals('Wrens')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Name"]')!.disabled
    ).equals(false)
    await act(async () => {
      finish!()
    })
    expect(text()).not.includes('Name saved')
  })
  it('keeps participation above parents and ends only the chosen participation, with retry', async () => {
    for (const kind of ['team', 'season'] as const) {
      const f = fixture(kind)
      const own = await f.client.group({ kind, id: 'canonical' })
      const parent = asPublicGroup({
        kind: 'league',
        id: 'harbor',
        name: 'Harbor League',
        locality: null,
        imageUrl: null
      })
      const counterpart = asPublicGroup({
        kind: kind === 'team' ? 'season' : 'team',
        id: 'participant',
        name: 'Spring Bluebirds',
        locality: null,
        imageUrl: null
      })
      let ended = false
      let fail = true
      f.client.group = async () => ({
        ...own,
        parents: [parent],
        participatingSeasons: kind === 'team' && !ended ? [counterpart] : [],
        competingTeams: kind === 'season' && !ended ? [counterpart] : []
      })
      const calls: unknown[] = []
      f.client.endParticipation = async (season, team) => {
        calls.push([season, team])
        if (fail) throw new Error('Participation unavailable')
        ended = true
      }
      await mount(
        <GroupSettingsScreen
          client={f.client}
          groupRef={{ kind, id: 'alias' }}
          onRequest={() => {}}
        />
      )
      const label =
        kind === 'team'
          ? 'End participation in Spring Bluebirds'
          : 'End participation for Spring Bluebirds'
      if (kind === 'team')
        expect(text().indexOf('SEASON PARTICIPATION')).lessThan(
          text().indexOf('PARENT ORGANIZATIONS')
        )
      await press(label)
      expect(text()).includes('Participation unavailable')
      fail = false
      await press(label)
      await settle()
      expect(calls[1]).deep.equals(
        kind === 'team'
          ? ['participant', 'canonical']
          : ['canonical', 'participant']
      )
      expect(text()).not.includes(label)
      await unmount()
    }
  })
  for (const kind of ['team', 'season', 'league'] as const)
    it(`shows ${kind} identity and saves the name without leaving settings`, async () => {
      const f = fixture(kind)
      const opened: GroupRef[] = []
      let changed = 0
      await mount(
        <GroupSettingsScreen
          client={f.client}
          groupRef={{ kind, id: 'alias' }}
          onLocation={ref => {
            opened.push(ref)
          }}
          onChanged={() => {
            changed++
          }}
        />
      )
      await settle()
      expect(
        document.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value
      ).equals('Bluebirds')
      expect(text())
        .includes(`${kind.toUpperCase()} DETAILS`)
        .and.not.includes('Save settings')
      expect(find('Add picture')).not.equals(undefined)
      expect(find('Save name')?.getAttribute('aria-disabled')).equals('true')
      await fill('Name', 'Wrens')
      await press('Save name')
      await settle()
      expect(f.calls).deep.equals([
        [{ kind, id: 'canonical' }, { name: 'Wrens' }]
      ])
      expect(changed).equals(1)
      expect(text()).includes('Name saved').and.includes('Wrens')
      if (kind === 'season') {
        expect(text()).not.includes('Toronto')
        expect(text()).includes('Time frame')
      } else {
        await press('Toronto, Ontario, Canada')
        expect(opened).deep.equals([{ kind, id: 'canonical' }])
      }
    })
  it('saves pictures through the sheet and preserves an unsaved name', async () => {
    const f = fixture()
    await mount(
      <GroupSettingsScreen
        client={f.client}
        groupRef={{ kind: 'team', id: 'alias' }}
      />
    )
    await settle()
    await fill('Name', 'Unsaved Bluebirds')
    await press('Add picture')
    await press('Use initials')
    await press('Save photo')
    await settle()
    expect(f.calls[0]).deep.equals([
      { kind: 'team', id: 'canonical' },
      { picture: { initials: true } }
    ])
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value
    ).equals('Unsaved Bluebirds')
  })
  it('keeps failed name saves recoverable and refuses blank names', async () => {
    const f = fixture()
    await mount(
      <GroupSettingsScreen
        client={f.client}
        groupRef={{ kind: 'team', id: 'alias' }}
      />
    )
    await settle()
    await fill('Name', '')
    expect(find('Save name')?.getAttribute('aria-disabled')).equals('true')
    await fill('Name', 'Wrens')
    f.controls.fail = true
    await press('Save name')
    await settle()
    expect(text()).includes('Save unavailable')
    f.controls.fail = false
    await press('Save name')
    await settle()
    expect(text()).includes('Name saved')
  })
  it('does not expose administrative controls to a viewer and retries loading errors', async () => {
    const f = fixture()
    f.controls.fail = true
    await mount(
      <GroupSettingsScreen
        client={f.client}
        groupRef={{ kind: 'team', id: 'alias' }}
      />
    )
    await settle()
    expect(text()).includes('Settings unavailable')
    f.controls.fail = false
    f.controls.allowed = false
    await press('Retry settings')
    await settle()
    expect(text()).includes('Only a current administrator')
    expect(find('Save name')).equals(undefined)
  })
  it('blocks competing saves and does not navigate on a stale completion', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    let changed = 0
    f.client.updateGroup = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return (await f.client.group({ kind: 'team', id: 'canonical' })).group
    }
    await mount(
      <GroupSettingsScreen
        client={f.client}
        groupRef={{ kind: 'team', id: 'alias' }}
        onChanged={() => {
          changed++
        }}
      />
    )
    await settle()
    await fill('Name', 'Wrens')
    await press('Save name')
    expect(find('Save name')?.getAttribute('aria-disabled')).equals('true')
    await unmount()
    await act(async () => {
      finish!()
    })
    expect(changed).equals(0)
  })
})
