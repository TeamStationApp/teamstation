import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { AnalyticsClient } from '../../common/observability/analyticsClient'
import type { Property } from '../../common/observability/contract'
import type { SponsoredRow } from '../../common/sponsors/types'
import { mount, settle, unmount } from '../../test/gameFormDom'
import {
  AnalyticsProvider,
  useAnalytics
} from '../observability/AnalyticsContext'
import { deviceId } from '../stream/deviceId'
import { SponsoredScheduleRow } from './SponsoredScheduleRow'
import { sendRowEvent, useSponsoredRowViews } from './sponsorRowEvents'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const row: SponsoredRow = {
  id: 'ser_row1',
  leagueId: 'lea_al',
  logoUrl: 'https://example.test/logo.png',
  backgroundUrl: '',
  title: 'Bayside Bakery',
  message: 'Fresh bread for every team after the game.',
  url: 'https://example.test/bread',
  textColor: 'dark',
  startsAt: '2026-11-25T18:00:00.000Z'
}
const other: SponsoredRow = { ...row, id: 'ser_row2', leagueId: 'lea_nl' }

/** A stand-in client: what it was asked to send, signed in or not. */
function recorder(identified: boolean): {
  client: AnalyticsClient
  sent: Array<{ event: string; properties: Record<string, Property> }>
} {
  const sent: Array<{ event: string; properties: Record<string, Property> }> =
    []
  const client = {
    identified,
    emit: async (event: string, properties: Record<string, Property> = {}) => {
      sent.push({ event, properties })
    }
  } as unknown as AnalyticsClient
  return { client, sent }
}

describe('sponsored row events', () => {
  it('names the row and its league, signed in, with no device', async () => {
    const { client, sent } = recorder(true)
    await sendRowEvent(client, 'sponsor_row_tapped', row, async () => {
      throw new Error('not asked')
    })
    expect(sent).deep.equals([
      {
        event: 'sponsor_row_tapped',
        properties: { er: 'ser_row1', lg: 'lea_al' }
      }
    ])
  })
  it('adds this device’s id, signed out', async () => {
    const { client, sent } = recorder(false)
    await sendRowEvent(client, 'sponsor_row_viewed', row)
    expect(sent).length(1)
    expect(sent[0].properties.dv).matches(UUID)
    expect(sent[0].properties.dv).equals(await deviceId())
    // A device id that cannot be read leaves the event without it.
    await sendRowEvent(client, 'sponsor_row_viewed', row, async () => {
      throw new Error('no storage')
    })
    expect(sent[1].properties).deep.equals({ er: 'ser_row1', lg: 'lea_al' })
    // No analytics, nothing at all.
    await sendRowEvent(undefined, 'sponsor_row_viewed', row)
    expect(sent).length(2)
  })
})

describe('useSponsoredRowViews', () => {
  const posted: Array<{ E: string; P: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  let analytics: AnalyticsClient | undefined
  let report!: (keys: readonly string[]) => void
  beforeEach(() => {
    posted.length = 0
    globalThis.fetch = (async (_url: string, options: RequestInit) => {
      posted.push(
        ...(JSON.parse(options.body as string) as Array<{
          E: string
          P: Record<string, unknown>
        }>)
      )
      return { status: 202 }
    }) as typeof fetch
  })
  afterEach(async () => {
    await unmount()
    globalThis.fetch = originalFetch
  })
  function Probe(props: { rows: readonly SponsoredRow[] }): null {
    analytics = useAnalytics()
    report = useSponsoredRowViews(props.rows, 30)
    return null
  }
  const memory = (): {
    getItem: (key: string) => Promise<string | null>
    setItem: (key: string, value: string) => Promise<void>
  } => {
    const kept = new Map<string, string>()
    return {
      getItem: async key => kept.get(key) ?? null,
      setItem: async (key, value) => {
        kept.set(key, value)
      }
    }
  }
  const sponsorEvents = async (): Promise<
    Array<{ E: string; P: Record<string, unknown> }>
  > => {
    await act(async () => {
      await analytics!.flush()
    })
    return posted.filter(event => event.E.startsWith('sponsor_'))
  }

  it('records each row that stays on screen, by its list key, and lets other keys be', async () => {
    await mount(
      <AnalyticsProvider endpoint="/api/v1/analytics/events" storage={memory()}>
        <Probe rows={[row, other]} />
      </AnalyticsProvider>
    )
    analytics!.identify('usr_viewer', 'token')
    await act(async () => {
      report(['gam_game1', 'sponsored:ser_row1', 'sponsored:ser_gone'])
    })
    await settle(80)
    // Leaving before the time is up records nothing.
    await act(async () => {
      report(['sponsored:ser_row2'])
      report([])
    })
    await settle(80)
    expect((await sponsorEvents()).map(event => event.P)).deep.equals([
      { er: 'ser_row1', lg: 'lea_al' }
    ])
  })
  it('stops its timers with the screen', async () => {
    await mount(
      <AnalyticsProvider endpoint="/api/v1/analytics/events" storage={memory()}>
        <Probe rows={[row]} />
      </AnalyticsProvider>
    )
    await act(async () => {
      report(['sponsored:ser_row1'])
    })
    await unmount()
    await settle(80)
    expect(posted.filter(event => event.E.startsWith('sponsor_'))).deep.equals(
      []
    )
  })
  it('records a press of a Schedule’s row and opens it, signed out with the device', async () => {
    const opened: string[] = []
    await mount(
      <AnalyticsProvider endpoint="/api/v1/analytics/events" storage={memory()}>
        <Probe rows={[]} />
        <SponsoredScheduleRow
          {...row}
          tracked={row}
          onOpen={url => {
            opened.push(url)
          }}
        />
      </AnalyticsProvider>
    )
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="sponsored-schedule-row"]')!
        .click()
    })
    expect(opened).deep.equals([row.url])
    const events = await sponsorEvents()
    expect(events.map(event => event.E)).deep.equals(['sponsor_row_tapped'])
    expect(events[0].P.er).equals('ser_row1')
    expect(events[0].P.lg).equals('lea_al')
    expect(events[0].P.dv).matches(UUID)
  })
  it('records nothing for a preview’s press', async () => {
    await mount(
      <AnalyticsProvider endpoint="/api/v1/analytics/events" storage={memory()}>
        <Probe rows={[]} />
        <SponsoredScheduleRow {...row} onOpen={() => undefined} />
      </AnalyticsProvider>
    )
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="sponsored-schedule-row"]')!
        .click()
    })
    expect(await sponsorEvents()).deep.equals([])
  })
})
