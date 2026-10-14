import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import { asPublicGroup } from '../../common/publicGroups'
import { find, mount, press, text, unmount } from '../../test/gameFormDom'
import {
  participationExplanation,
  SeasonParticipations
} from './SeasonParticipations'

const seasons = ['Winter Weekends', 'Spring Playoffs'].map((name, i) =>
  asPublicGroup({
    kind: 'season',
    id: `season-${i}`,
    name,
    imageUrl: null,
    locality: null
  })
)
describe('confirmed season participation departure', () => {
  afterEach(unmount)
  const client = (): TeamStationClient =>
    new TeamStationClient({ baseUrl: '/api/v1' })
  it('hides an empty list and respects a disabled parent form', async () => {
    const api = client()
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={[]}
        onLeft={() => {}}
      />
    )
    expect(text()).not.includes('SEASON PARTICIPATIONS')
    await unmount()
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={seasons}
        disabled
        onLeft={() => {}}
      />
    )
    expect(
      find('Leave season Winter Weekends')?.getAttribute('aria-disabled')
    ).equals('true')
    await press('Leave season Winter Weekends')
    expect(document.querySelector('[aria-label="Leave season"]')).equals(null)
  })
  it('keeps the explanation outside one card and dismisses without a write', async () => {
    const api = client()
    let writes = 0
    api.endParticipation = async () => {
      writes++
    }
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={seasons}
        onLeft={() => {}}
      />
    )
    const card = document.querySelector(
      '[data-testid="season-participations-card"]'
    )!
    expect(card.textContent)
      .includes('Winter Weekends')
      .and.includes('Spring Playoffs')
    expect(card.textContent).not.includes(participationExplanation)
    expect(text().split(participationExplanation)).length(2)
    await press('Leave season Winter Weekends')
    expect(text()).includes('Leave Winter Weekends?')
    await press('Cancel')
    expect(document.querySelector('[aria-label="Leave season"]')).equals(null)
    await press('Leave season Spring Playoffs')
    await press('Cancel season departure')
    expect(writes).equals(0)
  })
  it('retries a rejected write and refreshes only the selected season/team once', async () => {
    const api = client()
    let attempts = 0
    let refreshed = 0
    api.endParticipation = async (season, team) => {
      expect([season, team]).deep.equals(['season-1', 'canonical'])
      if (++attempts === 1) throw new Error('Season unavailable')
    }
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={seasons}
        onLeft={() => {
          refreshed++
        }}
      />
    )
    await press('Leave season Spring Playoffs')
    await press('Leave Spring Playoffs')
    expect(text()).includes('Season unavailable')
    expect(refreshed).equals(0)
    await press('Leave Spring Playoffs')
    expect(refreshed).equals(1)
    expect(document.querySelector('[aria-label="Leave season"]')).equals(null)
  })
  it('guards duplicate taps, busy dismissal and a completion after unmount', async () => {
    const api = client()
    let finish!: () => void
    let writes = 0
    let refreshed = 0
    api.endParticipation = async () => {
      writes++
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={seasons}
        onLeft={() => {
          refreshed++
        }}
      />
    )
    await press('Leave season Winter Weekends')
    await act(async () => {
      const button = find('Leave Winter Weekends')!
      button.click()
      button.click()
    })
    expect(writes).equals(1)
    expect(find('Cancel')?.getAttribute('aria-disabled')).equals('true')
    await press('Cancel season departure')
    expect(document.querySelector('[aria-label="Leave season"]')).not.equals(
      null
    )
    await unmount()
    await act(async () => {
      finish()
    })
    expect(refreshed).equals(0)
  })
  it('shows a retryable fallback for non-Error rejections', async () => {
    const api = client()
    api.endParticipation = async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise the unknown-rejection fallback.
      await Promise.reject({ offline: true })
    }
    await mount(
      <SeasonParticipations
        client={api}
        teamId="canonical"
        seasons={seasons}
        onLeft={() => {}}
      />
    )
    await press('Leave season Winter Weekends')
    await press('Leave Winter Weekends')
    expect(text()).includes('Participation could not end. Retry.')
    await press('Cancel')
  })
})
