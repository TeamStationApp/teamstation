import { expect } from 'chai'

import { TeamStationClient } from '../api'
import { HttpError } from '../errors'
import { type AnalyticsSink, observeApi } from './apiEvents'
import type { EventName, Property } from './contract'

describe('Private API analytics', () => {
  it('records the explicit discovery and membership catalog without user input', async () => {
    const rows: Array<{
      event: EventName
      properties: Record<string, Property>
    }> = []
    const sink: AnalyticsSink = (event, properties) => {
      rows.push({ event, properties })
    }
    const call = async (
      method: string,
      path: string,
      value?: unknown
    ): Promise<void> => {
      expect(
        await observeApi(
          method,
          path,
          async () => value,
          () => sink
        )
      ).equals(value)
    }
    await call('GET', '/teams?view=public&query=secret-canary', [
      { name: 'private-name' }
    ])
    await call('GET', '/teams/tem_example')
    await call('GET', '/seasons/sea_example')
    await call('GET', '/leagues/lea_example')
    await call('PUT', '/me/follows/team/tem_example')
    await call('DELETE', '/me/follows/team/tem_example')
    await call('POST', '/teams', { id: 'tem_example', name: 'private-name' })
    await call('POST', '/seasons', { id: 'private-name' })
    await call('POST', '/join/secret-canary/email-code')
    await call('POST', '/join/secret-canary/redeem')
    await call('POST', '/events', { id: 'gam_example' })
    await call('POST', '/game-requests', {
      status: 'accepted',
      gameId: 'gam_example'
    })
    await call('POST', '/game-requests', {
      status: 'pending',
      gameId: null,
      proposedGameId: 'gam_pending'
    })
    await call('POST', '/game-requests', { status: 'accepted', gameId: null })
    await call('GET', '/chat/secret-canary')
    expect(rows.map(row => row.event)).deep.equals([
      'search_submitted',
      'group_viewed',
      'group_viewed',
      'group_viewed',
      'follow_changed',
      'follow_changed',
      'group_created',
      'group_created',
      'join_requested',
      'join_requested',
      'invite_accepted',
      'event_created',
      'event_created'
    ])
    expect(rows[0].properties).deep.equals({ n: 1 })
    expect(rows[5].properties.ok).equals(false)
    expect(JSON.stringify(rows)).not.matches(/canary|private-name/)
  })

  it('preserves failures and results even when observers fail, excluding chat entirely', async () => {
    const events: string[] = []
    const capture = (): AnalyticsSink => event => {
      events.push(event)
    }
    for (const error of [
      new HttpError('offline', 'canary'),
      new HttpError('rateLimited', 'canary'),
      new HttpError('forbidden', 'canary'),
      new Error('canary')
    ]) {
      try {
        await observeApi(
          'GET',
          '/videos/vid_example/playback',
          async () => {
            throw error
          },
          capture
        )
        expect.fail()
      } catch (caught) {
        expect(caught).equals(error)
      }
    }
    const failed = new Error('private-chat')
    try {
      await observeApi(
        'POST',
        '/chat',
        async () => {
          throw failed
        },
        capture
      )
      expect.fail()
    } catch (caught) {
      expect(caught).equals(failed)
    }
    expect(events).deep.equals([
      'api_failed',
      'api_failed',
      'api_failed',
      'api_failed'
    ])
    expect(
      await observeApi(
        'POST',
        '/teams',
        async () => 1,
        () => {
          throw failed
        }
      )
    ).equals(1)
    expect(
      await observeApi(
        'POST',
        '/teams',
        async () => 2,
        () => () => {
          throw failed
        }
      )
    ).equals(2)
    expect(await observeApi('GET', '/health', async () => 3)).equals(3)
  })

  it('uses the real client request boundary without changing the request or result', async () => {
    const client = new TeamStationClient({
      baseUrl: 'https://api.example.test',
      fetch: (async (url: string, options: RequestInit) => {
        expect(url).equals('https://api.example.test/events')
        expect(options.method).equals('POST')
        return new Response(JSON.stringify({ id: 'gam_example' }))
      }) as typeof fetch
    })
    const events: string[] = []
    client.captureAnalytics = () => event => {
      events.push(event)
    }
    expect(
      await client.createTeamEvent({
        teamId: 'tem_example',
        title: 'Practice',
        startAt: '2030-01-01T00:00:00Z',
        timezone: 'UTC',
        venue: null,
        status: 'scheduled',
        idempotencyKey: 'synthetic'
      })
    ).deep.equals({
      id: 'gam_example'
    })
    expect(events).deep.equals(['event_created'])
  })
})
