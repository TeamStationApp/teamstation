import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import {
  asEventInfo,
  type EventInfo,
  type TeamEventInput
} from '../../common/eventInfo'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventDetailsForm } from './EventDetailsForm'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function render(
  client: TeamStationClient,
  info?: EventInfo
): Promise<string[]> {
  const saved: string[] = []
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <EventDetailsForm
          client={client}
          teamId="tem_demo"
          info={info}
          onSaved={id => {
            saved.push(id)
          }}
          onCancel={() => {
            saved.push('cancel')
          }}
        />
      </ThemeProvider>
    )
  })
  return saved
}
async function input(label: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!.bind(field)
  await act(async () => {
    setter(value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function click(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => node.textContent === label)
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
  })
}

describe('title event creation and event detail editing', () => {
  for (const editing of [false, true])
    it(`retains unsaved fields while a timezone is empty or partial (${editing ? 'edit' : 'create'})`, async () => {
      const client = new TeamStationClient({ baseUrl: '/api/v1' })
      const info = asEventInfo({
        id: 'tev_demo',
        eventKind: 'event',
        title: 'Team dinner',
        teamId: 'tem_demo',
        teamName: 'Owls',
        startAt: '2027-04-10T18:00:00Z',
        endAt: '2027-04-10T20:00:00Z',
        timezone: 'UTC',
        venue: null,
        address: null,
        latitude: null,
        longitude: null,
        status: 'scheduled',
        canManage: true,
        attendees: [],
        replyUserIds: []
      })
      let writes = 0
      client.createTeamEvent = async () => {
        writes++
        return { id: info.id }
      }
      client.updateEventInfo = async () => {
        writes++
        return info
      }
      const saved = await render(client, editing ? info : undefined)
      await input('Title', 'Unsaved team picnic')
      const submit = editing ? 'Save event details' : 'Create event'
      for (const zone of ['', 'America/']) {
        await input('Time zone', zone)
        expect(
          document.querySelector<HTMLInputElement>('input[aria-label="Title"]')
            ?.value
        ).equals('Unsaved team picnic')
        await click(submit)
        expect(document.body.textContent).includes('Choose a valid timezone')
        expect(writes).equals(0)
        expect(saved).deep.equals([])
      }
      await input('Time zone', 'UTC')
      await click(submit)
      expect(writes).equals(1)
      expect(saved).deep.equals([info.id])
    })
  it('creates an opponent-free event with an address and supports retry keys for failed delivery', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const sent: TeamEventInput[] = []
    client.createTeamEvent = async body => {
      sent.push(body)
      if (sent.length === 1) throw new Error('Try saving again')
      return { id: 'tev_demo' }
    }
    const saved = await render(client)
    await input('Title', ' Team dinner ')
    await input('Date', '2027-04-10')
    await input('Start time', '18:00')
    await input('Time zone', 'UTC')
    await input('Address (optional)', ' 1 Demo Way ')
    await click('Create event')
    expect(document.body.textContent).includes('Try saving again')
    await click('Create event')
    expect(saved).deep.equals(['tev_demo'])
    expect(sent[0]).includes({
      title: 'Team dinner',
      address: '1 Demo Way',
      teamId: 'tem_demo',
      startAt: '2027-04-10T18:00:00.000Z',
      endAt: null
    })
    expect(sent[0]).not.property('awayTeamId')
    expect(sent[1].idempotencyKey).equals(sent[0].idempotencyKey)
  })
  it('rejects invalid end ordering, accepts overnight events and cancels from editing', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let sent: Record<string, unknown> | undefined
    const info = asEventInfo({
      id: 'tev_demo',
      eventKind: 'event',
      title: 'Team dinner',
      teamId: 'tem_demo',
      teamName: 'Owls',
      startAt: '2027-04-10T18:00:00Z',
      endAt: '2027-04-10T20:00:00Z',
      timezone: 'UTC',
      venue: null,
      address: null,
      latitude: null,
      longitude: null,
      status: 'scheduled',
      canManage: true,
      replyUserIds: [],
      attendees: []
    })
    client.updateEventInfo = async (_id, body) => {
      sent = body
      return info
    }
    const saved = await render(client, info)
    await input('End time', '17:00')
    await click('Save event details')
    expect(document.body.textContent).includes(
      'End time must be after start time'
    )
    expect(sent).equals(undefined)
    await input('End date', '2027-04-11')
    await click('Cancel event')
    await click('Save event details')
    expect(sent).includes({
      endAt: '2027-04-11T17:00:00.000Z',
      status: 'cancelled'
    })
    expect(saved).deep.equals(['tev_demo'])
    await click('Back')
    expect(saved).deep.equals(['tev_demo', 'cancel'])
  })
  it('edits only a game’s address and end, preserving its scheduling approval fields', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const info = asEventInfo({
      id: 'g1',
      eventKind: 'game',
      title: null,
      teamId: 'tem_demo',
      teamName: 'Owls',
      startAt: '2027-04-10T18:00:00Z',
      endAt: null,
      timezone: 'UTC',
      venue: 'Demo Field',
      address: null,
      latitude: null,
      longitude: null,
      status: 'scheduled',
      canManage: true,
      replyUserIds: [],
      attendees: []
    })
    let sent: Record<string, unknown> | undefined
    client.updateEventInfo = async (_id, body) => {
      sent = body
      return info
    }
    await render(client, info)
    expect(document.querySelector('[aria-label="Title"]')).equals(null)
    expect(document.querySelector('[aria-label="Start time"]')).equals(null)
    await input('Address (optional)', '2 Demo Way')
    await click('End time: Not set')
    await click('Save event details')
    expect(sent).deep.equals({
      address: '2 Demo Way',
      endAt: '2027-04-10T20:00:00.000Z'
    })
  })
})
