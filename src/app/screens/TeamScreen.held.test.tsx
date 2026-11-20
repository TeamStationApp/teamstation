import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asTeamSummary, type GamesPageQuery } from '../../common/api'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { pageOfGames } from '../../test/pageOf'
import {
  HELD_TEAM_CONSEQUENCE,
  USE_SERVER_COPY
} from '../scoring/HeldGameNotice'
import { CachingClient } from '../sync/cachingClient'
import type { OutboxListener, OutboxSummary } from '../sync/outbox'
import { TeamScreen } from './TeamScreen'

const team = asTeamSummary({
  id: 'tem_home',
  name: 'Demo Home',
  shortName: null,
  logoPath: null
})

const held = (teams: OutboxSummary['teams']): OutboxSummary => ({
  count: Object.keys(teams).length,
  chains: {},
  games: {},
  teams
})

/** A phone's client holding `summary`, whose roster reads are counted. */
function phone(summary: OutboxSummary): {
  client: CachingClient
  calls: string[]
  set: (next: OutboxSummary) => void
} {
  const calls: string[] = []
  const listeners = new Set<OutboxListener>()
  let current = summary
  const set = (next: OutboxSummary): void => {
    current = next
    for (const listener of listeners) listener(next)
  }
  const client = Object.create(CachingClient.prototype) as CachingClient
  Object.assign(client, {
    subscribeOutbox: (listener: OutboxListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    outboxSummary: async () => current,
    subscribeOffline: () => () => undefined,
    teamGamesPage: async (_id: string, query?: GamesPageQuery) =>
      pageOfGames([], query),
    roster: async () => {
      calls.push('roster')
      return []
    },
    teamStats: async () => [],
    teamPitchingStats: async () => [],
    standings: async () => [],
    cached: async () => undefined,
    scheduleGames: async () => pageOfGames([], undefined),
    discardTeam: async (id: string) => {
      calls.push(`discard ${id}`)
      set(held({}))
      return true
    },
    retryTeam: async (id: string) => {
      calls.push(`retry ${id}`)
    }
  })
  return { client, calls, set }
}

const notice = (): HTMLElement | null =>
  document.querySelector('[data-testid="heldTeamNotice"]')

describe("a held team's page", () => {
  afterEach(async () => {
    await unmount()
  })

  it('says its new players were not saved, and takes the server’s copy and roster from the notice', async () => {
    const { client, calls } = phone(
      held({ tem_home: { state: 'dead', message: 'Only the team’s staff' } })
    )
    await mount(
      <TeamScreen
        client={client}
        team={team}
        initialTab="roster"
        onOpenGame={() => undefined}
      />
    )
    expect(notice()?.textContent).equals(
      'A player added on this phone was not saved: Only the team’s staff'
    )
    expect(
      document
        .querySelector('[data-testid="heldTeamMessage"]')
        ?.getAttribute('role')
    ).equals('alert')
    const before = calls.filter(call => call === 'roster').length
    await press('Unsent changes')
    expect(text()).includes(HELD_TEAM_CONSEQUENCE)
    await press(USE_SERVER_COPY)
    await settle(50)
    expect(calls).includes('discard tem_home')
    expect(notice()).equals(null)
    expect(
      calls.filter(call => call === 'roster').length,
      'one reload per clear'
    ).equals(before + 1)
  })

  it('reads the roster again when the hold is cleared elsewhere, and says nothing with none', async () => {
    const { client, calls, set } = phone(
      held({ tem_home: { state: 'dead', message: null } })
    )
    await mount(
      <TeamScreen
        client={client}
        team={team}
        initialTab="roster"
        onOpenGame={() => undefined}
      />
    )
    expect(notice()).not.equals(null)
    const before = calls.filter(call => call === 'roster').length
    await act(async () => {
      set(held({}))
    })
    await settle(50)
    expect(notice()).equals(null)
    expect(
      calls.filter(call => call === 'roster').length,
      'one reload per clear'
    ).equals(before + 1)
    // Another team's hold is not this page's.
    await act(async () => {
      set(held({ tem_other: { state: 'dead', message: null } }))
    })
    expect(notice()).equals(null)
  })

  it('starts afresh on another team: a held team left behind reloads nothing', async () => {
    const { client, calls } = phone(
      held({ tem_home: { state: 'dead', message: null } })
    )
    const other = asTeamSummary({
      id: 'tem_other',
      name: 'Demo Other',
      shortName: null,
      logoPath: null
    })
    let show: (next: typeof team) => void = () => undefined
    const Host = (): React.ReactElement => {
      const [shown, setShown] = React.useState(team)
      show = setShown
      return (
        <TeamScreen
          client={client}
          team={shown}
          initialTab="roster"
          onOpenGame={() => undefined}
        />
      )
    }
    await mount(<Host />)
    expect(notice()).not.equals(null)
    const before = calls.filter(call => call === 'roster').length
    await act(async () => {
      show(other)
    })
    await settle(50)
    expect(notice()).equals(null)
    // The other team's own read, and no reload for the hold left behind.
    expect(
      calls.filter(call => call === 'roster').length,
      'its own read only'
    ).equals(before + 1)
  })
})
