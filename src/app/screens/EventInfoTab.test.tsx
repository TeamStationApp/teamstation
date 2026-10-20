import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventInfoTab } from './EventInfoTab'
import type { RsvpEvent } from './EventRsvpModal'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
const initial = (): EventInfo =>
  asEventInfo({
    id: 'g1',
    eventKind: 'game',
    title: null,
    teamId: 'home',
    teamName: 'Owls',
    startAt: '2027-04-10T18:00:00Z',
    endAt: null,
    timezone: 'UTC',
    venue: null,
    address: null,
    latitude: null,
    longitude: null,
    status: 'scheduled',
    canManage: false,
    replyUserIds: [userIdOfGumbo(101), userIdOfGumbo(103), userIdOfGumbo(104)],
    attendees: [
      {
        userId: userIdOfGumbo(101),
        gumboId: 101,
        name: 'Babe R',
        avatarUrl: null,
        response: null,
        canReply: true,
        isTeamParticipant: true,
        isPlayer: true
      },
      {
        userId: userIdOfGumbo(103),
        gumboId: 103,
        name: 'Mike T',
        avatarUrl: null,
        response: null,
        canReply: true,
        isTeamParticipant: true,
        isPlayer: true
      },
      {
        userId: userIdOfGumbo(104),
        gumboId: 104,
        name: 'Ichiro',
        avatarUrl: null,
        response: null,
        canReply: true,
        isTeamParticipant: true,
        isPlayer: true
      },
      {
        userId: userIdOfGumbo(102),
        gumboId: 102,
        name: 'Lou G',
        avatarUrl: null,
        response: 'no',
        canReply: false,
        isTeamParticipant: true,
        isPlayer: false
      }
    ]
  })
const EVENT: RsvpEvent = {
  id: 'g1',
  homeTeamId: 'home',
  homeTeamName: 'Owls',
  awayTeamName: 'Demo Eagles',
  eventKind: 'game',
  eventType: 'game',
  title: ''
}
async function render(client: TeamStationClient): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <EventInfoTab client={client} eventId="g1" event={EVENT} />
      </ThemeProvider>
    )
  })
}
/** Opens the RSVP modal from anywhere in the card, as the schedule does. */
async function openReplies(): Promise<void> {
  await click('[data-testid="event-replies-open"]')
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(document.querySelector('[data-testid="event-rsvp-modal"]')).not.equals(
    null
  )
}
const status = (userId: number): HTMLElement =>
  document.querySelector(
    `[data-testid="event-reply-status-${userIdOfGumbo(userId)}"]`
  )!
async function click(selector: string): Promise<void> {
  const button = selector.startsWith('[')
    ? document.querySelector<HTMLElement>(selector)
    : [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === selector
      )
  expect(button, selector).not.equals(null)
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
}
const clientFor = (info = initial()): TeamStationClient => {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  // Replies are kept, so a reload shows what was saved.
  client.eventInfo = async () => structuredClone(info)
  client.eventLocation = async () => ({
    latitude: 34,
    longitude: 12,
    tileUrl: 'https://example.test/{z}/{x}/{y}'
  })
  client.saveRsvp = async (_id, userId, response) => {
    info.attendees = info.attendees.map(row =>
      row.userId === userId ? { ...row, response } : row
    )
    return { userId, response }
  }
  return client
}
describe('event Info location and family controls', () => {
  it('uses the displayed map coordinates for venue-only directions after lookup', async () => {
    const client = clientFor({ ...initial(), venue: 'Demo Park' })
    let complete:
      | ((location: {
          latitude: number
          longitude: number
          tileUrl: string
        }) => void)
      | undefined
    client.eventLocation = async () =>
      await new Promise(resolve => {
        complete = resolve
      })
    let openedUrl = ''
    const open = window.open.bind(window)
    window.open = url => {
      openedUrl = String(url)
      return null
    }
    try {
      await render(client)
      expect(
        document
          .querySelector('[data-testid="event-directions"]')
          ?.getAttribute('aria-label')
      ).equals('Directions unavailable')
      await click('[data-testid="event-directions"]')
      expect(openedUrl).equals('')
      await act(async () => {
        complete!({
          latitude: 34,
          longitude: 12,
          tileUrl: 'https://example.test/{z}/{x}/{y}'
        })
      })
      await click('[data-testid="event-address"]')
      expect(new URL(openedUrl).searchParams.get('destination')).equals('34,12')
      expect(
        document.querySelector('[data-testid="event-address"]')?.textContent
      ).equals('Demo Park')
    } finally {
      window.open = open
    }
  })
  it('keeps date/time in the hero and renders no duplicate beneath tabs', async () => {
    await render(clientFor())
    expect(document.body.textContent)
      .not.includes('UTC')
      .and.not.includes('2027')
  })
  it('lists each family reply as coloured text, opens the RSVP modal from anywhere in the card, and groups replies in order', async () => {
    const client = clientFor()
    let locations = 0
    client.eventLocation = async () => {
      locations++
      throw new Error('must not request an absent address')
    }
    await render(client)
    expect(document.body.textContent).includes('ARE YOU GOING?')
    // No capsules on the page: one line a person, the reply on the right.
    expect(document.querySelectorAll('[role="radiogroup"]')).length(0)
    const card = document.querySelector('[data-testid="event-replies"]')!
    expect(card.querySelectorAll('[data-testid^="event-reply-row-"]')).length(3)
    expect(document.querySelectorAll('[data-testid="event-replies"]')).length(1)
    expect([101, 103, 104].map(id => status(id).textContent)).deep.equals([
      'No reply',
      'No reply',
      'No reply'
    ])
    expect(document.querySelector('iframe')).equals(null)
    expect(locations).equals(0)
    await openReplies()
    expect(document.querySelectorAll('[role="radiogroup"]')).length(3)
    await click('[data-testid="event-rsvp-usr_111111111111111111112k-0"]')
    await click('[data-testid="event-rsvp-usr_111111111111111111112n-2"]')
    await click('[data-testid="event-rsvp-usr_111111111111111111112o-0"]')
    await click('[data-testid="event-rsvp-usr_111111111111111111112k-1"]')
    expect(
      document
        .querySelector(
          '[data-testid="event-rsvp-usr_111111111111111111112k-1"]'
        )
        ?.getAttribute('aria-checked')
    ).equals('true')
    await click('Done')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(document.querySelector('[data-testid="event-rsvp-modal"]')).equals(
      null
    )
    expect([101, 103, 104].map(id => status(id).textContent)).deep.equals([
      'Maybe',
      'No',
      'Yes'
    ])
    // Blue, red and green, as on the capsule.
    expect([101, 103, 104].map(id => status(id).style.color)).deep.equals([
      'rgb(35, 118, 207)',
      'rgb(203, 57, 65)',
      'rgb(32, 138, 75)'
    ])
    expect(
      document.querySelector('[data-testid="attendance-players-yes"]')
        ?.textContent
    ).includes('Ichiro')
    expect(
      document.querySelector('[data-testid="attendance-players-maybe"]')
        ?.textContent
    ).includes('Babe R')
    expect(
      document.querySelector('[data-testid="attendance-players-no"]')
        ?.textContent
    ).includes('Mike T')
    expect(
      document.querySelector('[data-testid="attendance-others-no"]')
        ?.textContent
    ).includes('Lou G')
    expect(
      document.querySelector('[data-testid="attendance-players-noReply"]')
    ).equals(null)
    expect(document.body.textContent).not.includes('No one yet')
  })
  it('rolls back only a failed row and lets a different child write while it is pending', async () => {
    const client = clientFor()
    let rejectRow: (error: Error) => void = () => undefined
    client.saveRsvp = async (_id, userId, response) =>
      userId === userIdOfGumbo(101)
        ? await new Promise((_resolve, reject) => {
            rejectRow = reject
          })
        : { userId, response }
    await render(client)
    await openReplies()
    await click('[data-testid="event-rsvp-usr_111111111111111111112k-0"]')
    expect(
      document
        .querySelector(
          '[data-testid="event-rsvp-usr_111111111111111111112k-0"]'
        )
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await click('[data-testid="event-rsvp-usr_111111111111111111112o-2"]')
    await act(async () => {
      rejectRow(new Error('Your guardian access changed. Reload.'))
    })
    expect(document.body.textContent).includes('Your guardian access changed')
    expect(
      document.querySelector(
        '[data-testid="event-rsvp-usr_111111111111111111112k-1"]'
      )?.textContent
    ).equals('No reply')
    expect(
      document
        .querySelector(
          '[data-testid="event-rsvp-usr_111111111111111111112o-2"]'
        )
        ?.getAttribute('aria-checked')
    ).equals('true')
    client.saveRsvp = async (_id, userId, response) => ({ userId, response })
    await click('[data-testid="event-rsvp-usr_111111111111111111112k-0"]')
    expect(document.body.textContent).not.includes(
      'Your guardian access changed'
    )
    await click('Done')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
  })
  it('shows recoverable initial load and map failures, then renders the actual map document on retry', async () => {
    const info = {
      ...initial(),
      address: '1 Demo Way',
      endAt: '2027-04-10T20:00:00Z'
    }
    const client = clientFor(info)
    client.eventInfo = async () => {
      throw new Error('Attendance unavailable')
    }
    await render(client)
    expect(document.body.textContent).includes('Attendance unavailable')
    client.eventInfo = async () => info
    client.eventLocation = async () => {
      throw new Error('Map unavailable')
    }
    await click('Retry event information')
    expect(document.body.textContent).includes('Map unavailable')
    client.eventLocation = async () => ({
      latitude: 34,
      longitude: 12,
      tileUrl: 'https://example.test/{z}/{x}/{y}'
    })
    await click('Retry map')
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).includes(
      'L.map'
    )
    expect(document.body.textContent).not.includes('8:00 PM')
  })
  it('leaves editing in Settings and places the map after the family cards', async () => {
    const client = clientFor({
      ...initial(),
      canManage: true,
      address: '1 Demo Way'
    })
    await render(client)
    expect(document.body.textContent).not.includes('Edit event details')
    const reply = document.querySelector(
      '[data-testid="event-reply-row-usr_111111111111111111112o"]'
    )!
    const map = document.querySelector('[data-testid="event-location"]')!
    expect(
      reply.compareDocumentPosition(map) &
        window.Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    const address = document.querySelector('[data-testid="event-address"]')!
    expect(
      map.querySelector('iframe')!.compareDocumentPosition(address) &
        window.Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
  })
  it('keeps the location view available when a server supplies an empty map key', async () => {
    const client = clientFor({ ...initial(), address: '1 Demo Way' })
    client.eventLocation = async () => ({
      latitude: 34,
      longitude: 12,
      tileUrl: 'https://example.test/{z}/{x}/{y}',
      googleMapsApiKey: ''
    })
    await render(client)
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).includes(
      'L.map'
    )
    expect(document.body.textContent).includes('1 Demo Way')
  })
  it('keeps the visitor location view free of private attendance and RSVP controls', async () => {
    const client = clientFor({
      ...initial(),
      canViewAttendance: false,
      attendees: [],
      replyUserIds: []
    })
    await render(client)
    expect(document.body.textContent).includes('Join a participating team')
    expect(document.querySelector('[role="radiogroup"]')).equals(null)
    expect(document.querySelector('[data-testid="attendance-yes"]')).equals(
      null
    )
    expect(document.body.textContent).not.includes('ARE YOU GOING?')
  })
  for (const dual of [false, true])
    it(`shows the team capsule only for dual affiliation (${dual}) below the map`, async () => {
      const value = {
        ...initial(),
        address: '1 Demo Way',
        attendanceTeams: [
          { id: 'home', name: 'Demo Hawks', isParticipant: true },
          { id: 'away', name: 'Demo Eagles', isParticipant: dual }
        ]
      }
      const client = clientFor(value)
      let selected: string | undefined
      client.eventInfo = async (_id, team) => {
        selected = team
        return { ...value, teamId: team ?? 'home' }
      }
      await render(client)
      expect(
        document.querySelector('[data-testid="event-attendance-teams"]')
          ?.textContent ?? ''
      ).not.includes('RSVPs')
      const selector = document.querySelector(
        '[data-testid="event-attendance-teams"]'
      )
      if (!dual) {
        expect(selector).equals(null)
        return
      }
      expect(selector!.textContent).equals('Demo HawksDemo Eagles')
      expect(
        document
          .querySelector('[data-testid="event-location"]')!
          .compareDocumentPosition(selector!) &
          window.Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
      await act(async () => {
        selector!
          .querySelector<HTMLElement>('[aria-label="Demo Eagles"]')!
          .click()
      })
      expect(selected).equals('away')
      expect(
        selector!
          .querySelector('[aria-label="Demo Eagles"]')!
          .getAttribute('aria-selected')
      ).equals('true')
    })
})
