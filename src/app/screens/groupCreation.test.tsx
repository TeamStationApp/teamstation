import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asTeamSummary, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { NodeAccount } from '../../common/nodeAdministration'
import type { Notification } from '../../common/notifications'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { seasonTimeFrames } from '../../common/seasonTimeFrames'
import { DateRangePicker } from '../components/DateRangePicker'
import { GroupPictureChooser } from '../components/GroupPictureChooser'
import { seasonParticipantDestination } from '../navigation/seasonParticipant'
import { ThemeProvider } from '../theme/ThemeContext'
import { CreateGroupScreen } from './CreateGroupScreen'
import { DiscoverScreen } from './DiscoverScreen'
import { GroupLinkScreen } from './GroupLinkScreen'
import { GroupScreen } from './GroupScreen'
import { GroupSettingsScreen } from './GroupSettingsScreen'
import { NodeAdministrationScreen } from './NodeAdministrationScreen'
import {
  NotificationDetailScreen,
  NotificationsScreen
} from './NotificationsScreen'
import { PromoteExternalScreen } from './PromoteExternalScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
}
async function fill(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 280))
  })
}
const group = asPublicGroup({
  id: 'team_demo',
  kind: 'team',
  name: 'Demo Hawks',
  imageUrl: null,
  locality: null
})
const detail = asGroupDetail({
  group,
  parents: [],
  children: [],
  participatingSeasons: [],
  competingTeams: [],
  staff: [],
  games: [],
  canManage: true,
  canViewPrivate: true
})
function client(): TeamStationClient {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.pictures = async () => []
  api.ownGroups = async () => [group]
  api.discoverGroups = async () => [group]
  api.group = async () => detail
  return api
}
const notification: Notification = {
  id: 'event_demo',
  requestId: 'request_demo',
  type: 'participation',
  title: 'Demo Hawks invited to Demo Spring',
  description: 'Mike Trout from Demo League invited the Hawks.',
  sentAt: '2026-10-06T12:00:00Z',
  expiresAt: '2026-10-13T12:00:00Z',
  status: 'pending',
  canAct: true,
  canWithdraw: true,
  canResend: true,
  viewed: false
}

describe('creation and organization interface behavior', () => {
  it('forwards Home-linked Teams and Standings permissions to the shared participant opener', async () => {
    const api = client()
    const participants = [
      asTeamSummary({
        id: 'tem_owned',
        name: 'Owned participant',
        shortName: null,
        logoPath: null,
        canViewPrivate: true
      }),
      asTeamSummary({
        id: 'tem_guest',
        name: 'Visiting participant',
        shortName: null,
        logoPath: null,
        canViewPrivate: false
      }),
      asTeamSummary({
        id: 'tem_placeholder',
        name: 'Custodied placeholder',
        shortName: null,
        logoPath: null,
        kind: 'external',
        canViewPrivate: false
      })
    ]
    api.group = async () => ({
      ...detail,
      group: { ...group, kind: 'season', id: 'sea_demo' }
    })
    api.seasonGames = async () => []
    api.seasonTeams = async () => participants
    api.standings = async () =>
      participants.map(item => ({
        teamId: item.id,
        teamName: item.name,
        w: 0,
        l: 0,
        t: 0,
        played: 0,
        winningPct: null,
        runsFor: 0,
        runsAgainst: 0,
        runDifferential: 0,
        logoUrl: null,
        teamKind: item.kind,
        gamesBehind: null,
        streak: null,
        home: { w: 0, l: 0, t: 0 },
        away: { w: 0, l: 0, t: 0 }
      }))
    const destinations: unknown[] = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'season', id: 'sea_demo' }}
        initialTab="teams"
        onOpen={() => {
          throw new Error(
            'Season participant bypassed its permission-aware opener'
          )
        }}
        onOpenTeam={team =>
          destinations.push(seasonParticipantDestination(team))
        }
        onCreate={() => {}}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
      />
    )
    await settle()
    for (const item of participants) await press('Open ' + item.name)
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find(node => node.textContent === 'Standings')!
        .click()
    })
    for (const item of participants) await press('Open ' + item.name)
    expect(destinations).deep.equals(
      [...participants, ...participants].map(item =>
        item.canViewPrivate
          ? { name: 'team', team: item }
          : { name: 'group', kind: 'team', id: item.id }
      )
    )
  })
  it('preserves canceled public history without granting private game access', async () => {
    const api = client()
    const base = {
      homeTeam: { id: group.id, name: group.name },
      awayTeam: { id: 'tem_guest', name: 'Demo Guest' },
      seasonId: 'sea_host',
      startAt: '2027-03-02T18:00:00Z',
      venue: 'Demo Field',
      homeScore: 4,
      awayScore: 1,
      withdrawnByTeamId: null,
      pendingApproval: false,
      pendingRequestId: null
    }
    api.group = async () =>
      asGroupDetail({
        ...detail,
        canViewPrivate: false,
        canManage: false,

        games: [
          {
            ...base,
            id: 'gam_approved',
            status: 'final',
            cancellationReason: null
          },
          {
            ...base,
            id: 'gam_withdrawn',
            status: 'cancelled',
            cancellationReason: 'withdrawal',
            withdrawnByTeamName: 'Demo Guest'
          },
          {
            ...base,
            id: 'gam_replaced',
            status: 'cancelled',
            cancellationReason: 'replacement',
            homeScore: null,
            awayScore: null
          }
        ]
      })
    const opened: Array<{ id: string; options: unknown }> = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'team', id: group.id }}
        initialTab="schedule"
        onOpen={() => undefined}
        onCreate={() => undefined}
        onSettings={() => undefined}
        onLink={() => undefined}
        onPrivate={() => undefined}
        onOpenGame={(id, _title, options) => opened.push({ id, options })}
      />
    )
    expect(document.body.textContent).includes('final · 1–4')
    expect(document.body.textContent).includes('Canceled — Demo Guest withdrew')
    expect(document.body.textContent!.match(/Canceled/g)).has.lengthOf(2)
    expect(opened).deep.equals([])
    expect(document.body.textContent).not.includes('Open game')
  })
  it('opens an authorized hosted proposal without granting private access to the visiting team', async () => {
    const api = client()
    api.group = async () =>
      asGroupDetail({
        ...detail,
        canManage: false,
        canViewPrivate: false,
        games: [
          {
            id: 'gam_reserved',
            homeTeam: { id: group.id, name: group.name },
            awayTeam: { id: 'tem_guest', name: 'Demo Guest' },
            seasonId: 'sea_host',
            startAt: '2027-03-02T18:00:00Z',
            venue: null,
            status: 'scheduled',
            homeScore: null,
            awayScore: null,
            cancellationReason: null,
            withdrawnByTeamId: null,
            pendingApproval: true,
            pendingRequestId: 'req_host'
          }
        ]
      })
    const opened: Array<{ id: string; options: unknown }> = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'team', id: group.id }}
        initialTab="schedule"
        onOpen={() => undefined}
        onCreate={() => undefined}
        onSettings={() => undefined}
        onLink={() => undefined}
        onPrivate={() => undefined}
        onOpenGame={(id, _title, options) => opened.push({ id, options })}
      />
    )
    expect(document.body.textContent).includes('Pending approval')
    expect(document.body.textContent).not.includes('Open team videos and stats')
    await press('Open game')
    expect(opened).deep.equals([
      { id: 'gam_reserved', options: { pendingRequestId: 'req_host' } }
    ])
  })
  it('continues an incompatible single parent choice into a reviewed multi-party batch and sends exactly the reviewed actions', async () => {
    const api = client()
    const league = {
      ...group,
      kind: 'league' as const,
      id: 'league_other',
      name: 'Demo Other League'
    }
    api.ownGroups = async () => [group, league]
    api.discoverGroups = async () => [group, league]
    api.group = async ref => ({
      ...detail,
      group: ref.kind === 'team' ? group : { ...league, id: ref.id }
    })
    api.parentPreview = async changes => {
      if (changes.length < 2)
        throw new HttpError('conflict', 'Review an explicit compatible batch')
      return {
        actions: changes,
        effects: changes,
        expected: {},
        explanation: ['Reviewed both changes; games preserved']
      }
    }
    let sent: unknown
    api.inviteRelationship = async body => {
      sent = body
      return { id: 'request_batch', status: 'pending' }
    }
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: { kind: 'league', id: 'league_demo' },
          targetKind: 'team',
          direction: 'children',
          relationship: 'parent'
        }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await settle()
    await press('Choose Demo Hawks')
    expect(document.body.textContent).includes(
      'Review an explicit compatible batch'
    )
    await press('Add another parent change')
    await settle()
    await press('Remove parent')
    await press('Choose change Demo Hawks')
    await settle()
    await press('Choose change Demo Other League')
    await press('Review all parent changes')
    expect(document.body.textContent).includes('Reviewed both changes')
    await press('Send invitation')
    expect(sent)
      .property('actions')
      .deep.equals([
        {
          operation: 'detach',
          child: { kind: 'team', id: group.id },
          parent: { kind: 'league', id: league.id }
        },
        {
          operation: 'attach',
          child: { kind: 'team', id: group.id },
          parent: { kind: 'league', id: 'league_demo' }
        }
      ])
  })
  it('resolves parent locality on a fresh creation form and requires confirming the team suggestion', async () => {
    const api = client()
    const locality = {
      city: 'Demo Parent Town',
      region: 'Demo Region',
      country: 'US',
      placeId: null,
      timezone: 'America/New_York'
    }
    api.group = async () => ({
      ...detail,
      group: { ...group, kind: 'league', id: 'league_parent', locality }
    })
    let saved: unknown
    api.createGroup = async body => {
      saved = body
      return {
        id: 'team_new',
        kind: body.kind,
        name: body.name,
        imageUrl: null
      }
    }
    await mount(
      <CreateGroupScreen
        client={api}
        kind="team"
        parent={{ kind: 'league', id: 'league_parent' }}
        onCreated={() => {}}
        onCancel={() => {}}
      />
    )
    await fill('Team name', 'Demo New Hawks')
    await press('Continue')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search city and state"]'
      )!.value
    ).equals('Demo Parent Town')
    const next = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(
      node =>
        (node.getAttribute('aria-label') ?? node.textContent) === 'Continue'
    )!
    expect(next.getAttribute('aria-disabled')).equals('true')
    await press('Choose Demo Parent Town, Demo Region, US')
    await press('Continue')
    await press('Use initials')
    await press('Create Team')
    expect(saved).property('locality').deep.equals(locality)
  })
  it('uses a league confirmed timezone for a season created through a reloaded parent reference', async () => {
    const api = client()
    api.group = async () => ({
      ...detail,
      group: {
        ...group,
        kind: 'league',
        id: 'league_parent',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'America/New_York'
        }
      }
    })
    let zone = ''
    api.createGroup = async body => {
      zone = body.timezone ?? ''
      return {
        id: 'season_new',
        kind: body.kind,
        name: body.name,
        imageUrl: null
      }
    }
    await mount(
      <CreateGroupScreen
        client={api}
        kind="season"
        parent={{ kind: 'league', id: 'league_parent' }}
        onCreated={() => {}}
        onCancel={() => {}}
      />
    )
    await fill('Season name', 'Demo New Season')
    await press('Continue')
    await press(seasonTimeFrames()[1].label)
    await press('Continue')
    await press('Use initials')
    await press('Create Season')
    expect(zone).equals('America/New_York')
  })
  it('retains loaded invitation details offline, disables decisions and clears them on an explicit access refusal', async () => {
    const api = client()
    let decisions = 0
    api.notification = async () => notification
    api.viewNotification = async () => {}
    api.decideRelationship = async () => {
      decisions++
      return { id: notification.requestId, status: 'accepted' }
    }
    await mount(
      <NotificationDetailScreen
        client={api}
        id={notification.requestId}
        onChanged={() => {}}
      />
    )
    api.notification = async () => {
      throw new HttpError('offline', 'Offline read')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).includes(notification.description)
    expect(document.body.textContent).includes('Showing the saved invitation')
    await press('Accept invitation')
    expect(decisions).equals(0)
    api.notification = async () => notification
    await press('Retry invitation')
    await press('Accept invitation')
    expect(decisions).equals(1)
    api.notification = async () => {
      throw new HttpError('forbidden', 'Access removed')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).not.includes(notification.description)
  })
  it('does not show or submit a previous invitation while a different route is loading or offline', async () => {
    const api = client()
    let resolveNext!: (value: Notification) => void
    api.notification = async id =>
      id === notification.requestId
        ? notification
        : await new Promise(resolve => {
            resolveNext = resolve
          })
    api.viewNotification = async () => {}
    const decisions: string[] = []
    api.decideRelationship = async id => {
      decisions.push(id)
      return { id, status: 'accepted' }
    }
    await mount(
      <NotificationDetailScreen
        client={api}
        id={notification.requestId}
        onChanged={() => {}}
      />
    )
    expect(document.body.textContent).includes(notification.title)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NotificationDetailScreen
            client={api}
            id="request_next"
            onChanged={() => {}}
          />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).not.includes(notification.title)
    expect(document.body.textContent).not.includes('Accept invitation')
    expect(decisions).deep.equals([])
    const next = {
      ...notification,
      requestId: 'request_next',
      id: 'event_next',
      title: 'Demo Next Invite'
    }
    await act(async () => {
      resolveNext(next)
    })
    api.notification = async () => next
    await press('Accept invitation')
    expect(decisions).deep.equals(['request_next'])
  })
  it('retains the loaded inbox on transport failure and clears it on authoritative permission loss', async () => {
    const api = client()
    api.notifications = async () => ({
      items: [notification],
      nextCursor: null,
      hasPending: true
    })
    await mount(<NotificationsScreen client={api} onOpen={() => {}} />)
    api.notifications = async () => {
      throw new HttpError('offline', 'Offline read')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).includes(notification.title)
    api.notifications = async () => {
      throw new HttpError('forbidden', 'Access removed')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).not.includes(notification.title)
  })
  it('discards an older private invitation response after a newer refusal and preserves resend retry identity', async () => {
    const api = client()
    let resolveOld!: (value: Notification) => void
    let calls = 0
    api.notification = async () => {
      if (++calls === 1)
        return await new Promise(resolve => {
          resolveOld = resolve
        })
      throw new HttpError('forbidden', 'Permission removed')
    }
    api.viewNotification = async () => {}
    await mount(
      <NotificationDetailScreen
        client={api}
        id="request_demo"
        onChanged={() => {}}
      />
    )
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).includes('Permission removed')
    await act(async () => {
      resolveOld(notification)
    })
    expect(document.body.textContent).not.includes(notification.title)
    await act(async () => {
      root!.unmount()
    })
    api.notification = async () => notification
    const keys: Array<string | undefined> = []
    api.decideRelationship = async (id, action, key) => {
      keys.push(key)
      throw new Error('Resend offline')
    }
    await mount(
      <NotificationDetailScreen
        client={api}
        id="request_demo"
        onChanged={() => {}}
      />
    )
    await press('Resend invitation')
    await press('Resend invitation')
    expect(keys[0]).equals(keys[1])
    expect(document.body.textContent).includes('Resend offline')
  })
  it('moderates node accounts with explicit confirmation, recovers errors and protects the last node in the interface', async () => {
    const api = client()
    const account: NodeAccount = {
      userId: 106,
      displayName: 'Hank Aaron',
      email: 'hank@example.com',
      isNodeAdmin: false,
      suspended: false,
      loginEnabled: true,
      canRemoveNodeRole: true
    }
    api.nodeAccounts = async () => [
      account,
      {
        ...account,
        userId: 105,
        displayName: 'Babe Ruth',
        isNodeAdmin: true,
        canRemoveNodeRole: false
      }
    ]
    let changed = 0
    api.changeNodeAccount = async () => {
      throw new Error('Replacement needed')
    }
    await mount(
      <NodeAdministrationScreen
        client={api}
        onChanged={id => {
          changed = id
        }}
      />
    )
    expect(document.body.textContent).includes(
      'final active node administrator'
    )
    await press('Suspend Hank Aaron')
    await press('Keep account unchanged')
    await press('Grant node role to Hank Aaron')
    await press('Confirm account change')
    expect(document.body.textContent).includes('Replacement needed')
    api.changeNodeAccount = async () => {}
    await press('Confirm account change')
    expect(changed).equals(106)
    api.nodeAccounts = async () => [
      { ...account, isNodeAdmin: true, suspended: true }
    ]
    await press('Refresh accounts')
    await press('Reactivate Hank Aaron')
    await press('Confirm account change')
    await press('Remove node role from Hank Aaron')
    await press('Keep account unchanged')
    api.nodeAccounts = async () => []
    await fill('Find an account', 'Nobody')
    expect(document.body.textContent).includes('No accounts match')
    api.nodeAccounts = async () => {
      throw new Error('Lookup offline')
    }
    await press('Refresh accounts')
    expect(document.body.textContent).includes('Lookup offline')
  })
  it('retries an external-team administrator email invitation without claiming ownership until acceptance', async () => {
    const api = client()
    let sent = ''
    let cancelled = false
    api.inviteRelationship = async () => {
      throw new Error('Verify your email first')
    }
    await mount(
      <PromoteExternalScreen
        client={api}
        teamId={group.id}
        onSent={id => {
          sent = id
        }}
        onCancel={() => {
          cancelled = true
        }}
      />
    )
    await fill('Administrator email', 'recipient@example.com')
    await press('Send administrator invitation')
    expect(document.body.textContent).includes('Verify your email first')
    api.inviteRelationship = async () => ({
      id: 'promotion_request',
      status: 'pending'
    })
    await press('Send administrator invitation')
    expect(sent).equals('promotion_request')
    await press('Cancel')
    expect(cancelled).equals(true)
  })
  it('selects inclusive calendar ranges, resets reversed selection, and supports cancellation and month navigation', async () => {
    let chosen: unknown
    let cancelled = false
    await mount(
      <DateRangePicker
        now={new Date(2028, 1, 1)}
        onChoose={range => {
          chosen = range
        }}
        onCancel={() => {
          cancelled = true
        }}
      />
    )
    await press('Previous month')
    await press('Next month')
    await press('2028-02-29')
    await press('2028-02-28')
    await press('2028-02-28')
    await press('Use this range')
    expect(chosen).deep.equals({ startsOn: '2028-02-28', endsOn: '2028-02-28' })
    await press('Cancel')
    expect(cancelled).equals(true)
  })
  it('keeps gallery loading and canceled album selection retryable while allowing a default picture', async () => {
    const api = client()
    api.pictures = async () => {
      throw new Error('Offline')
    }
    let changed: unknown
    await mount(
      <GroupPictureChooser
        client={api}
        name="Demo Profile"
        allowCatalog
        value={{ image: { contentType: 'image/png', base64: 'AAAA' } }}
        onChange={value => {
          changed = value
        }}
      />
    )
    expect(document.body.textContent).includes('could not load')
    api.pictures = async () => [
      {
        id: 'baseball',
        label: 'Baseball',
        kind: 'photo',
        prefix: 'images/catalog/baseball',
        sha256: '',
        width: 192,
        height: 192,
        url: 'data:image/png;base64,AAAA'
      }
    ]
    await press('Retry pictures')
    await press('Baseball')
    expect(changed).deep.equals({ catalogId: 'baseball' })
    await press('Add Photo')
    document
      .querySelector('input[type="file"]')!
      .dispatchEvent(new window.Event('cancel'))
    await act(async () => {
      await Promise.resolve()
    })
    await press('Use initials')
    expect(changed).deep.equals({ initials: true })
  })
  it('keeps season creation retryable, preserves its name, and supports previous step and custom cancellation', async () => {
    const api = client()
    let saved = ''
    let completed = false
    api.createGroup = async () => {
      throw new Error('Save offline')
    }
    await mount(
      <CreateGroupScreen
        client={api}
        kind="season"
        onCreated={() => {
          completed = true
        }}
        onCancel={() => {}}
      />
    )
    await fill('Season name', 'Demo Classic')
    await press('Continue')
    await press('Custom time frame')
    await press('Cancel')
    await press(seasonTimeFrames()[0].label)
    await press('Continue')
    await press('Use initials')
    await press('Create Season')
    expect(document.body.textContent).includes('Save offline')
    await press('Previous step')
    await press('Previous step')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Season name"]'
      )!.value
    ).equals('Demo Classic')
    api.createGroup = async fields => {
      saved = fields.name
      return {
        id: 'season_demo',
        kind: 'season',
        name: fields.name,
        imageUrl: null
      }
    }
    await press('Continue')
    await press('Continue')
    await press('Create Season')
    expect(saved).equals('Demo Classic')
    expect(completed).equals(true)
  })
  it('recovers discovery after an error and opens only the selected public group', async () => {
    const api = client()
    let opened = ''
    api.discoverGroups = async () => {
      throw new Error('Discovery offline')
    }
    await mount(
      <DiscoverScreen
        client={api}
        onOpen={ref => {
          opened = ref.id
        }}
      />
    )
    await settle()
    expect(document.body.textContent).includes('Discovery offline')
    api.discoverGroups = async () => [group]
    await press('Retry discovery')
    await settle()
    await press('Open Demo Hawks')
    expect(opened).equals('team_demo')
    await press('Leagues')
    await settle()
    await press('Seasons')
    await settle()
    await fill('Search by name or city', 'No match')
    api.discoverGroups = async () => []
    await settle()
    expect(document.body.textContent).includes('No matching seasons')
  })
  it('keeps new group actions bound to their route after a previous foreground response arrives', async () => {
    const api = client()
    const league = {
      ...group,
      kind: 'league' as const,
      id: 'league_old',
      name: 'Demo Old League'
    }
    const season = {
      ...group,
      kind: 'season' as const,
      id: 'season_current',
      name: 'Demo Current Season'
    }
    let resolveOld!: (value: typeof detail) => void
    let resolveNew!: (value: typeof detail) => void
    let hold = false
    api.group = async ref =>
      ref.id === league.id
        ? hold
          ? await new Promise(resolve => {
              resolveOld = resolve
            })
          : { ...detail, group: league }
        : await new Promise(resolve => {
            resolveNew = resolve
          })
    let parent: unknown
    const screen = (ref: {
      kind: 'league' | 'season'
      id: string
    }): React.ReactElement => (
      <GroupScreen
        client={api}
        groupRef={ref}
        onOpen={() => {}}
        onCreate={(_kind, selected) => {
          parent = selected
        }}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
      />
    )
    await mount(screen(league))
    hold = true
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    await act(async () => {
      root!.render(<ThemeProvider>{screen(season)}</ThemeProvider>)
    })
    expect(document.body.textContent).not.includes(league.name)
    expect(document.body.textContent).not.includes('Create Team')
    await act(async () => {
      resolveNew({ ...detail, group: season })
    })
    await act(async () => {
      resolveOld({ ...detail, group: league })
    })
    expect(document.body.textContent).includes(season.name)
    expect(document.body.textContent).not.includes(league.name)
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find(node => node.textContent === 'Teams')!
        .click()
    })
    await press('Create team')
    expect(parent).deep.equals({ kind: 'season', id: season.id })
  })
  it('does not restore an older group refresh after a newer access refusal', async () => {
    const api = client()
    let resolveOld!: (value: typeof detail) => void
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'team', id: group.id }}
        onOpen={() => {}}
        onCreate={() => {}}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
      />
    )
    api.group = async () =>
      await new Promise(resolve => {
        resolveOld = resolve
      })
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    api.group = async () => {
      throw new HttpError('forbidden', 'Group access removed')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    await act(async () => {
      resolveOld(detail)
    })
    expect(document.body.textContent).includes('Group access removed')
    expect(document.body.textContent).not.includes(group.name)
    expect(document.body.textContent).not.includes('Manage people')
  })
  it('renders public team tabs and exposes authorized management only through the gear', async () => {
    const api = client()
    let managed = ''
    api.group = async () => ({
      ...detail,
      canManage: false,
      canViewPrivate: false
    })
    const render = (): React.ReactElement => (
      <GroupScreen
        client={api}
        groupRef={{ kind: 'team', id: group.id }}
        onOpen={() => {}}
        onCreate={() => {}}
        onSettings={ref => {
          managed = ref.id
        }}
        onLink={() => {}}
        onPrivate={() => {}}
      />
    )
    await mount(render())
    expect(document.body.textContent).includes('membership is required')
    expect(document.body.textContent).not.includes('Manage people')
    await act(async () => {
      root!.unmount()
    })
    api.group = async () => ({
      ...detail,
      canManage: true,
      canViewPrivate: false
    })
    await mount(render())
    await press('Team settings')
    expect(managed).equals('team_demo')
    expect(document.body.textContent).not.includes('Group settings')
    expect(document.body.textContent).not.includes('Open team videos and stats')
  })
  it('preserves an invitation selection and explicit both-side choice across a sending error', async () => {
    const api = client()
    let sent = false
    api.parentPreview = async actions => ({
      actions,
      effects: actions,
      expected: {},
      explanation: ['Permissions only']
    })
    api.inviteRelationship = async () => {
      throw new Error('Sending offline')
    }
    await mount(
      <GroupLinkScreen
        client={api}
        choice={{
          subject: { kind: 'league', id: 'league_demo' },
          targetKind: 'team',
          direction: 'children',
          relationship: 'parent'
        }}
        onSent={() => {
          sent = true
        }}
        onCancel={() => {}}
      />
    )
    await settle()
    await press('Choose Demo Hawks')
    await press('I approve for all affected groups')
    await press('Confirm relationship')
    expect(document.body.textContent).includes('Sending offline')
    api.inviteRelationship = async () => ({
      id: 'request_demo',
      status: 'accepted'
    })
    await press('Confirm relationship')
    expect(sent).equals(true)
    await press('Choose another group')
    await press('Retry candidates')
    await settle()
  })
  it('keeps settings errors retryable, names the kind of settings and has no relationship controls', async () => {
    const api = client()
    let saved = false
    api.group = async () => ({
      ...detail,
      parents: [{ ...group, kind: 'league', id: 'league_demo' }]
    })
    api.updateGroup = async () => {
      throw new Error('Settings offline')
    }
    await mount(
      <GroupSettingsScreen
        client={api}
        groupRef={{ kind: 'team', id: group.id }}
        onLink={() => {}}
        onSaved={() => {
          saved = true
        }}
      />
    )
    const text = document.body.textContent
    expect(text).includes('Team Settings')
    expect(text).not.includes('Group settings')
    expect(text).not.includes('Parent relationships')
    expect(text).not.includes('Break relationship')
    expect(text).not.includes('Add parent league')
    await press('Save settings')
    expect(document.body.textContent).includes('Settings offline')
    api.updateGroup = async () => group
    await press('Save settings')
    expect(saved).equals(true)
    await press('Change picture')
    await press('Use initials')
  })
  it('titles league and season settings by their kind', async () => {
    for (const kind of ['league', 'season'] as const) {
      const api = client()
      api.group = async () => ({
        ...detail,
        group: { ...group, kind, id: `${kind}_demo` },
        children: [{ ...group, kind: 'team', id: 'child_demo' }]
      })
      await mount(
        <GroupSettingsScreen
          client={api}
          groupRef={{ kind, id: `${kind}_demo` }}
          onLink={() => {}}
          onSaved={() => {}}
        />
      )
      const text = document.body.textContent
      expect(text).includes(
        kind === 'league' ? 'League Settings' : 'Season Settings'
      )
      expect(text).not.includes('Child relationships')
      expect(text).not.includes('Break parent relationship')
      await act(async () => root?.unmount())
      document.body.replaceChildren()
    }
  })
  it('separates viewing, shared decisions and resend navigation and clears detail on permission loss', async () => {
    const api = client()
    let current = notification
    let replacement = ''
    api.notification = async () => current
    api.viewNotification = async () => {}
    api.decideRelationship = async (_id, action) => {
      if (action === 'resend') return { id: 'request_new', status: 'pending' }
      current = {
        ...current,
        status:
          action === 'decline'
            ? 'declined'
            : action === 'withdraw'
              ? 'cancelled'
              : 'accepted',
        canAct: false,
        canWithdraw: false
      }
      return { id: current.requestId, status: current.status }
    }
    await mount(
      <NotificationDetailScreen
        client={api}
        id={notification.requestId}
        onChanged={id => {
          replacement = id ?? ''
        }}
      />
    )
    expect(document.body.textContent).includes(
      'Opening this invitation does not approve it'
    )
    await press('Resend invitation')
    expect(replacement).equals('request_new')
    await press('Accept invitation')
    expect(document.body.textContent).includes('Accepted')
    api.notification = async () => {
      throw new HttpError('notFound', 'Not found')
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).not.includes(notification.description)
  })
  it('paginates shared notifications and retries loading while keeping pending separate from sent and history', async () => {
    const api = client()
    let opened = ''
    api.notifications = async () => {
      throw new Error('Inbox offline')
    }
    await mount(
      <NotificationsScreen
        client={api}
        onOpen={id => {
          opened = id
        }}
      />
    )
    expect(document.body.textContent).includes('Inbox offline')
    api.notifications = async options => ({
      items:
        options?.cursor == null
          ? [notification]
          : [
              {
                ...notification,
                id: 'event_next',
                requestId: 'request_next',
                title: 'Next invitation'
              }
            ],
      hasPending: true,
      nextCursor: options?.cursor == null ? 'next' : null
    })
    await press('Retry notifications')
    await press('Load more')
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(document.body.textContent).includes('Next invitation')
    await press('Next invitation')
    expect(opened).equals('request_next')
    await press('Sent')
    await press('History')
  })
})
