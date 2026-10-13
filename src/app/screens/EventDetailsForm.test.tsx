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
import {
  chooseSchedule,
  pressSchedule,
  typeSchedule
} from '../../test/eventScheduleDom'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventDetailsForm } from './EventDetailsForm'

let root: Root | undefined

async function render(
  client: TeamStationClient,
  info?: EventInfo,
  hideTitle = false
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
          hideTitle={hideTitle}
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
  if (
    [
      'Date',
      'End date',
      'Time',
      'Start time',
      'End time',
      'Time zone'
    ].includes(label)
  ) {
    await chooseSchedule(label, value)
    return
  }
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )!
  const setter = Object.getOwnPropertyDescriptor(
    field.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
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
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  for (const editing of [false, true])
    it(`retains unsaved fields while searching or canceling timezone autocomplete (${editing ? 'edit' : 'create'})`, async () => {
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
        await pressSchedule('[data-testid="event-schedule-timezone"]')
        await typeSchedule('Find time zone', zone)
        expect(
          document.querySelector<HTMLInputElement>('input[aria-label="Title"]')
            ?.value
        ).equals('Unsaved team picnic')
        expect(writes).equals(0)
        await pressSchedule('Cancel time zone picker')
        expect(saved).deep.equals([])
      }
      await input('Time zone', 'UTC')
      await click(submit)
      expect(writes).equals(1)
      expect(saved).deep.equals([info.id])
    })
  it('leaves its title to a scene that names itself', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    await render(client, undefined, true)
    expect(document.body.textContent).not.includes('Create Event')
    expect(document.querySelector('input[aria-label="Title"]')).not.equals(null)
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
    await input('Venue address (optional)', ' 1 Demo Way ')
    await input('Notes (optional)', 'Field 2\nMeet by gate')
    await input('Arrival minutes (optional)', '45')
    await click('Create event')
    expect(document.body.textContent).includes('Try saving again')
    await click('Create event')
    expect(saved).deep.equals(['tev_demo'])
    expect(sent[0]).includes({
      title: 'Team dinner',
      address: '1 Demo Way',
      notes: 'Field 2\nMeet by gate',
      arrivalTimeDelta: 45,
      eventType: 'other',
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
    await input('Time zone', 'UTC')
    await input('Start time', '18:00')
    await click('Set end date')
    await input('End date', '2027-04-10')
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
})
