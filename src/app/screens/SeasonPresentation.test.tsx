import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asSeasonGame,
  asSeasonSummary,
  type GamesPageQuery,
  type TeamStationClient
} from '../../common/api'
import {
  asGroupDetail,
  asPublicGroup,
  type GroupDetail
} from '../../common/publicGroups'
import type { SponsoredRow } from '../../common/sponsors/types'
import {
  chatAgeSheet,
  pillTabs,
  pressChatAge,
  TestChatAge
} from '../../test/chatAgeTesting'
import { pageOfGames } from '../../test/pageOf'
import { ThemeProvider } from '../theme/ThemeContext'
import { SeasonPresentation } from './SeasonPresentation'

/** A season's page links to the season's chats its viewer is in. */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

const season = asSeasonSummary({
  id: 'sea_spring',
  leagueId: null,
  name: 'Spring 2027',
  year: 2027,
  term: null,
  ageGroup: null,
  teams: 0,
  games: 0,
  videos: 0
})

/** Every read answers nothing; the season's group detail is refused. */
const client = new Proxy(
  {},
  {
    get: (_, name) =>
      name === 'group'
        ? async () => {
            throw new Error('offline')
          }
        : async () => []
  }
) as TeamStationClient

describe('entity chat season sections', function () {
  it('links to each one, and opens it', async function () {
    const opened: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonPresentation
            client={client}
            season={season}
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
            chats={[{ id: 'cnv_org', title: 'Spring Org' }]}
            onOpenChat={chat => opened.push(chat.id)}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(document.querySelector('[data-testid="entity-chats"]')).equals(null)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-label="Chats"]')!
        .click()
    })
    const link = document.querySelector<HTMLElement>(
      '[role="button"][aria-label="Open Spring Org"]'
    )
    expect(link, 'the chat’s link').not.equals(null)
    await act(async () => {
      link!.click()
      await delay(10)
    })
    expect(opened).deep.equals(['cnv_org'])
  })

  it('draws no links without a way to open them', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonPresentation
            client={client}
            season={season}
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
            chats={[{ id: 'cnv_org', title: 'Spring Org' }]}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(
      document.querySelector('[role="button"][aria-label="Open Spring Org"]')
    ).equals(null)
  })

  it('keeps the Chats pill while chat is locked, and Not Now leaves a Chats address for the default tab', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    for (const access of ['ask', 'blocked'] as const) {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <TestChatAge key={access} access={access}>
              <SeasonPresentation
                client={client}
                season={season}
                onOpenGame={() => undefined}
                onOpenTeam={() => undefined}
                initialTab="chats"
                chats={[{ id: 'cnv_org', title: 'Spring Org' }]}
                onOpenChat={() => undefined}
              />
            </TestChatAge>
          </ThemeProvider>
        )
        await delay(20)
      })
      expect(pillTabs().labels).includes('Chats')
      expect(chatAgeSheet(), access).not.equals(null)
      expect(document.querySelector('[data-testid="entity-chat-list"]')).equals(
        null
      )
      await act(async () => {
        pressChatAge(access === 'ask' ? 'close' : 'ok')
        await delay(20)
      })
      expect(chatAgeSheet()).equals(null)
      expect(pillTabs().selected).not.equals('Chats')
    }
  })
})

describe('U34 a season’s sponsored rows', function () {
  const games = [
    asSeasonGame({
      id: 'gam_one',
      homeTeamId: 'tem_sox',
      awayTeamId: 'tem_yanks',
      homeTeamName: 'Sox',
      awayTeamName: 'Yanks',
      homeTeamExternal: false,
      awayTeamExternal: false,
      seasonId: 'sea_spring',
      startAt: '2027-04-03T17:00:00.000Z',
      venue: 'Field One',
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      ingestStatus: 'none',
      videoCount: 0,
      durationSec: null,
      posterUrl: null,
      homeLogoUrl: null,
      awayLogoUrl: null,
      isLive: false,
      externalIds: []
    })
  ]
  games.push({
    ...games[0],
    id: 'gam_two',
    startAt: '2027-04-17T17:00:00.000Z',
    venue: 'Field Two'
  })
  const rows: SponsoredRow[] = [
    {
      id: 'srw_al',
      leagueId: 'lea_al',
      logoUrl: '',
      backgroundUrl: '',
      title: 'Harbor Bakery',
      message: 'Fresh bread after games.',
      url: 'https://example.test/bread',
      textColor: 'dark',
      startsAt: '2027-04-10T17:00:00.000Z'
    },
    {
      id: 'srw_nl',
      leagueId: 'lea_nl',
      logoUrl: '',
      backgroundUrl: '',
      title: 'Old Diner',
      message: 'Breakfast all day.',
      url: 'https://example.test/diner',
      textColor: 'white',
      startsAt: '2026-01-01T17:00:00.000Z'
    }
  ]

  /** The season's Schedule on `when`, its reads recorded. */
  async function schedule(
    when: 'upcoming' | 'all',
    publicDetail?: GroupDetail
  ): Promise<unknown[]> {
    const asked: unknown[] = []
    const reads = {
      group: async () => {
        throw new Error('offline')
      },
      seasonGamesPage: async (_id: string, query: GamesPageQuery) =>
        pageOfGames(games, query),
      publicGamesPage: async (
        _kind: string,
        _id: string,
        query: GamesPageQuery
      ) =>
        pageOfGames(
          games.map(game => ({
            ...game,
            homeTeam: { id: game.homeTeamId, name: game.homeTeamName },
            awayTeam: { id: game.awayTeamId, name: game.awayTeamName }
          })),
          query
        ),
      sponsorRows: async (query: unknown) => {
        asked.push(query)
        return rows
      }
    }
    const seasonClient = new Proxy(reads, {
      get: (target, name) =>
        (target as Record<string | symbol, unknown>)[name] ?? (async () => [])
    }) as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonPresentation
            client={seasonClient}
            season={season}
            publicDetail={publicDetail}
            initialTab="schedule"
            initialWhen={when}
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
          />
        </ThemeProvider>
      )
      await delay(30)
    })
    return asked
  }
  const order = (...texts: string[]): number[] => {
    const page = document.body.textContent ?? ''
    return texts.map(each => page.indexOf(each))
  }

  it('places every league’s rows among All’s games, newest first', async function () {
    const asked = await schedule('all')
    expect(asked).deep.equals([{ season: 'sea_spring' }])
    const places = order('Field Two', 'Harbor Bakery', 'Field One', 'Old Diner')
    expect(places[0]).greaterThan(-1)
    expect([...places].sort((a, b) => a - b)).deep.equals(places)
  })

  it('keeps Upcoming to rows still ahead, soonest first', async function () {
    await schedule('upcoming')
    const places = order('Field One', 'Harbor Bakery', 'Field Two')
    expect(places[0]).greaterThan(-1)
    expect([...places].sort((a, b) => a - b)).deep.equals(places)
    expect(document.body.textContent).not.includes('Old Diner')
  })

  it('reads a visitor’s rows as the public page', async function () {
    const asked = await schedule(
      'all',
      asGroupDetail({
        group: asPublicGroup({
          id: 'sea_spring',
          kind: 'season',
          name: 'Spring 2027',
          imageUrl: null,
          locality: null
        }),
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        staff: [],
        games: [],
        nonMemberView: false,
        canManage: false,
        canViewPrivate: false
      })
    )
    expect(asked).deep.equals([{ season: 'sea_spring', public: true }])
    expect(document.body.textContent).includes('Harbor Bakery')
  })
})
