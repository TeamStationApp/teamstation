import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { pageOfGames } from '../../test/pageOf'
import { ThemeProvider } from '../theme/ThemeContext'
import { GroupScreen } from './GroupScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40))
  })
}
function control(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.getAttribute('aria-label') === label
  )
}

const NAMES = {
  team: 'Demo Hawks',
  season: 'Demo Spring',
  league: 'Demo League'
} as const
const SETTINGS = {
  team: 'Team settings',
  season: 'Season settings',
  league: 'League settings'
} as const

function client(
  kind: 'team' | 'season' | 'league',
  access: {
    canManage: boolean
    canViewPrivate: boolean
    canSeePeople?: boolean
  },
  followed: boolean
): { api: TeamStationClient; calls: string[] } {
  const group = asPublicGroup({
    id: `${kind}_demo`,
    kind,
    name: NAMES[kind],
    imageUrl: null,
    locality: null
  })
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  const calls: string[] = []
  api.group = async () =>
    asGroupDetail({
      group,
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      nonMemberView: false,
      ...access,
      // A league member reads its people. canViewPrivate stays a team and
      // season signal, so a league says belonging here.
      ...(kind === 'league' && access.canSeePeople == null
        ? { canSeePeople: access.canViewPrivate }
        : {})
    })
  api.follows = async () => (followed ? [group] : [])
  api.follow = async ref => {
    calls.push(`follow:${ref.id}`)
    return group
  }
  api.unfollow = async ref => {
    calls.push(`unfollow:${ref.id}`)
  }
  // A member's private lists, which this test does not look at.
  api.teamGamesPage = async (_id, query) => pageOfGames([], query)
  api.roster = async () => []
  api.teamStats = async () => []
  api.teamPitchingStats = async () => []
  api.seasonGamesPage = async (_id, query) => pageOfGames([], query)
  api.seasonTeams = async () => []
  api.standings = async () => []
  return { api, calls }
}

async function mount(api: TeamStationClient, kind: GroupKind): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const ref: GroupRef = { kind, id: `${kind}_demo` }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GroupScreen
          client={api}
          groupRef={ref}
          onOpen={() => {}}
          onCreate={() => {}}
          onSettings={() => {}}
          onLink={() => {}}
          onPrivate={() => {}}
        />
      </ThemeProvider>
    )
  })
  await settle()
}

describe('Follow on a league, season or team hero', () => {
  for (const kind of ['league', 'team', 'season'] as const) {
    const name = NAMES[kind]
    const settings = SETTINGS[kind]
    it(`lets a visitor follow and unfollow a ${kind} where the gear would be`, async () => {
      const { api, calls } = client(
        kind,
        { canManage: false, canViewPrivate: false },
        false
      )
      await mount(api, kind)
      expect(control(settings)).equals(undefined)
      await act(async () => {
        control(`Follow ${name}`)!.click()
      })
      await settle()
      await act(async () => {
        control(`Unfollow ${name}`)!.click()
      })
      await settle()
      expect(calls).deep.equals([
        `follow:${kind}_demo`,
        `unfollow:${kind}_demo`
      ])
    })
    it(`shows Following on a ${kind} already followed`, async () => {
      const { api } = client(
        kind,
        { canManage: false, canViewPrivate: false },
        true
      )
      await mount(api, kind)
      expect(control(`Unfollow ${name}`)).not.equals(undefined)
    })
    it(`keeps the gear and no Follow for a ${kind}'s administrator, and nothing for a member`, async () => {
      const admin = client(
        kind,
        { canManage: true, canViewPrivate: false },
        false
      )
      await mount(admin.api, kind)
      expect(control(settings)).not.equals(undefined)
      expect(control(`Follow ${name}`)).equals(undefined)
      await act(async () => root?.unmount())
      document.body.replaceChildren()
      const member = client(
        kind,
        { canManage: false, canViewPrivate: true },
        false
      )
      await mount(member.api, kind)
      expect(control(`Follow ${name}`)).equals(undefined)
      expect(control(`Unfollow ${name}`)).equals(undefined)
    })
  }
  it('offers no Follow to a league member, who can see its people', async () => {
    const { api } = client(
      'league',
      { canManage: false, canViewPrivate: false, canSeePeople: true },
      true
    )
    await mount(api, 'league')
    expect(control('League settings')).equals(undefined)
    expect(control('Follow Demo League')).equals(undefined)
    expect(control('Unfollow Demo League')).equals(undefined)
  })
})
