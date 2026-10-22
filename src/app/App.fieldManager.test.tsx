import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import type { Notification } from '../common/notifications'
import { asGroupDetail } from '../common/publicGroups'
import type { SchedulePreview } from '../common/schedulePreviews'
import { userIdOfGumbo } from '../common/userId'
import type { VenueSummary } from '../common/venues'
import { press, settle } from '../test/gameFormDom'
import { venueDetail, venueField } from '../test/venueDom'
import { App } from './App'
import { parseRoute, routePath } from './navigation/routes'

const proto = TeamStationClient.prototype
const originals = Object.getOwnPropertyDescriptors(proto)
let root: Root | undefined
let host: HTMLElement | undefined

const summary = (overrides: Partial<VenueSummary>): VenueSummary => ({
  id: 'ven_demo',
  placeId: 'example-park',
  name: 'Example Park',
  address: '1 Example Way',
  owners: [{ claimId: 'vcl_a', leagueId: 'lea_a', name: 'Demo League A' }],
  pendingClaim: false,
  claimed: true,
  group: 'yours',
  distanceKm: null,
  ...overrides
})

function signedIn(canManage = true): void {
  proto.whoAmI = async () =>
    asSessionUser({
      id: userIdOfGumbo(101),
      displayName: 'Demo Admin',
      isAdmin: false
    })
  proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
  proto.hasNotifications = async () => false
  proto.teams = async () => []
  proto.ownGroups = async () => []
  proto.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group: {
        id: ref.id,
        kind: ref.kind,
        name: 'Demo League A',
        locality: null,
        imageUrl: null
      },
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage
    })
  proto.venue = async () => venueDetail({ fields: [venueField()] })
  proto.gamesToReschedule = async () => []
  proto.scheduleSetup = async leagueId => ({
    leagueId,
    seasonIds: ['sea_a'],
    fieldIds: [],
    seasons: [
      {
        id: 'sea_a',
        name: 'Demo Regular',
        year: 2027,
        timezone: 'UTC',
        participants: 2,
        exhibitionTeams: 0,
        teams: [],
        saved: false,
        settings: {
          fieldSize: '60/90',
          gameMinutes: 120,
          bufferMinutes: 15,
          regularGames: 0,
          exhibitionGames: 0,
          doubleheaders: 'ifNecessary',
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          blackouts: [],
          windows: []
        }
      }
    ],
    fields: []
  })
  proto.venueForPlace = async placeId =>
    venueDetail({ id: null, placeId, name: 'Harbor Field' })
}

async function open(path: string): Promise<void> {
  window.history.replaceState(null, '', path)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<App />)
  })
  await settle(150)
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
  window.history.replaceState(null, '', '/')
  for (const [name, descriptor] of Object.entries(originals))
    Object.defineProperty(proto, name, descriptor)
})

describe('the Auto-Scheduler and Field Manager in the app', () => {
  it('parses and writes the scheduler and venue addresses', () => {
    for (const path of [
      '/groups/league/lea_a/scheduler',
      '/groups/league/lea_a/scheduler/fields',
      '/groups/league/lea_a/scheduler/seasons/sea_a',
      '/groups/league/lea_a/scheduler/previews/spv_a',
      '/venues/ven_a',
      '/venues/place/harbor-field',
      '/venues/ven_a/fields/fld_one'
    ])
      expect(routePath(parseRoute(path, ''))).equals(path)
    expect(parseRoute('/groups/season/sea_a/scheduler', '').name).not.equals(
      'autoScheduler'
    )
    expect(
      parseRoute('/groups/league/lea_a/scheduler/seasons/', '')
    ).deep.equals({ name: 'autoScheduler', leagueId: 'lea_a' })
    expect(parseRoute('/venues', '')).deep.equals({ name: 'home' })
    expect(parseRoute('/venues/place', '')).deep.equals({ name: 'home' })
  })

  it('opens the Auto-Scheduler from the league page, then the Field Manager, a venue and a field', async () => {
    signedIn()
    const searches: unknown[] = []
    proto.venues = async options => {
      searches.push(options)
      return options?.query === 'Harbor'
        ? [
            summary({
              id: null,
              placeId: 'harbor-field',
              name: 'Harbor Field',
              owners: [],
              claimed: false,
              group: 'unclaimed'
            })
          ]
        : [
            summary({}),
            summary({
              id: 'ven_other',
              name: 'Example Field',
              group: 'claimed',
              pendingClaim: true,
              owners: [],
              distanceKm: 2.4
            })
          ]
    }
    await open('/groups/league/lea_a')
    await press('Auto-Scheduler, Fields, season settings and schedules')
    await settle()
    expect(window.location.pathname).equals('/groups/league/lea_a/scheduler')
    await press('Open Demo Regular')
    await settle(200)
    expect(window.location.pathname).equals(
      '/groups/league/lea_a/scheduler/seasons/sea_a'
    )
    expect(document.body.textContent).includes('No game windows yet.')
    window.history.back()
    await settle(300)
    expect(window.location.pathname).equals('/groups/league/lea_a/scheduler')
    await press(
      'Field Manager, Find, claim and set up the venues and fields your league plays on'
    )
    await settle(400)
    expect(window.location.pathname).equals(
      '/groups/league/lea_a/scheduler/fields'
    )
    const body = document.body.textContent!
    expect(body).includes('Your leagues’ venues')
    expect(body).includes('Claimed venues')
    expect(body).includes('Claim pending')
    expect(body).includes('2.4 km')
    expect(body).includes('Allow location access')
    await press('Open Example Park')
    await settle(200)
    expect(window.location.pathname).equals('/venues/ven_demo')
    await press('Open Field 1')
    await settle(200)
    expect(window.location.pathname).equals('/venues/ven_demo/fields/fld_one')
    expect(searches[0]).deep.equals({ query: '', near: undefined })
  })

  it('searches and opens a Google place, and shows an empty search and a failure', async () => {
    signedIn()
    let fail = true
    proto.venues = async options => {
      if (fail) throw new Error('down')
      return options?.query === 'Harbor'
        ? [
            summary({
              id: null,
              placeId: 'harbor-field',
              name: 'Harbor Field',
              owners: [],
              claimed: false,
              group: 'unclaimed'
            })
          ]
        : []
    }
    await open('/groups/league/lea_a/scheduler/fields')
    expect(document.body.textContent).includes('Venues could not load')
    fail = false
    await press('Retry')
    await settle(200)
    expect(document.body.textContent).includes('No claimed venues yet')
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Search venues"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'Nothing')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await settle(500)
    expect(document.body.textContent).includes('No venues match')
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'Harbor')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await settle(500)
    expect(document.body.textContent).includes('Unclaimed venues')
    await press('Open Harbor Field')
    await settle(200)
    expect(window.location.pathname).equals('/venues/place/harbor-field')
    expect(document.body.textContent).includes('Harbor Field')
  })

  it('offers no Auto-Scheduler to someone who does not run the league', async () => {
    signedIn(false)
    await open('/groups/league/lea_a')
    expect(document.body.textContent).not.includes('Auto-Scheduler')
  })

  it('opens a preview, and a recalculated one takes its place', async () => {
    signedIn()
    const preview = (id: string): SchedulePreview => ({
      id,
      leagueId: 'lea_a',
      mode: 'full',
      existing: 'workAround',
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [
        {
          games: [
            {
              key: 'g1',
              seasonId: 'sea_a',
              homeTeamId: 'tem_a',
              awayTeamId: 'tem_b',
              exhibition: false,
              fieldId: 'fld_one',
              size: '50/70',
              startAt: '2027-04-17T14:00:00.000Z',
              endAt: '2027-04-17T15:30:00.000Z'
            }
          ],
          fairness: [],
          reasons: [],
          unmet: [],
          score: [0]
        }
      ],
      blocking: null,
      edits: { option: 0, rejectedGameKeys: ['g0'], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [
        { id: 'tem_a', name: 'Demo Hawks' },
        { id: 'tem_b', name: 'Demo Owls' }
      ],
      seasons: [
        {
          id: 'sea_a',
          name: 'Demo Regular',
          timezone: 'UTC',
          gameMinutes: 90,
          participants: ['tem_a', 'tem_b'],
          exhibitionTeams: []
        }
      ],
      fields: [
        {
          id: 'fld_one',
          name: 'Field 1',
          venueName: 'Example Park',
          sizes: ['50/70']
        }
      ]
    })
    proto.schedulePreview = async id => preview(id)
    proto.buildSchedulePreview = async () => preview('spv_b')
    await open('/groups/league/lea_a/scheduler/previews/spv_a')
    expect(document.body.textContent).includes('Owls at Demo Hawks')
    await press('Recalculate')
    await settle(200)
    expect(window.location.pathname).equals(
      '/groups/league/lea_a/scheduler/previews/spv_b'
    )
  })

  it('opens what a scheduling notice names', async () => {
    const notice = (overrides: Partial<Notification>): Notification => ({
      id: 'aud_1',
      requestId: 'aud_1',
      type: 'venueClaim',
      title: 'Demo League A claimed Example Park',
      description: 'Approve or reject within 7 days.',
      sentAt: '2027-04-01T00:00:00.000Z',
      expiresAt: '2027-04-01T00:00:00.000Z',
      status: 'accepted',
      canAct: false,
      canWithdraw: false,
      canResend: false,
      viewed: false,
      leave: null,
      ...overrides
    })
    for (const [item, path] of [
      [notice({ venueId: 'ven_demo' }), '/venues/ven_demo'],
      [notice({ type: 'fieldWarning', gameId: 'gam_1' }), '/games/gam_1'],
      [
        notice({ type: 'scheduleNeedsAttention', leagueId: 'lea_a' }),
        '/groups/league/lea_a/scheduler'
      ],
      [
        notice({ type: 'schedulePublished', seasonId: 'sea_a' }),
        '/groups/season/sea_a'
      ],
      [
        notice({ type: 'schedulePublished', teamId: 'tem_a' }),
        '/groups/team/tem_a'
      ]
    ] as const) {
      signedIn()
      const viewed: string[] = []
      proto.notifications = async () => ({
        items: [item],
        hasPending: true,
        nextCursor: null
      })
      proto.viewNotification = async id => {
        viewed.push(id)
      }
      await open('/notifications')
      await press(item.title)
      await settle(200)
      expect(window.location.pathname, item.type).equals(path)
      expect(viewed).deep.equals(['aud_1'])
      await act(async () => {
        root?.unmount()
      })
      host?.remove()
      root = undefined
    }
  })
})
