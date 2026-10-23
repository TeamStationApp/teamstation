/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import {
  asGameDetail,
  asPersonProfile,
  asPlayerDetail,
  asRosterEntry,
  asSeasonGame,
  asSessionUser,
  asTeamSummary,
  TeamStationClient
} from '../common/api'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { App } from './App'

const playerId = userIdOfGumbo(201)
const team = asTeamSummary({
  id: 'tem_hawks',
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null
})
const game = asSeasonGame({
  id: 'game_demo',
  homeTeamId: 'tem_hawks',
  awayTeamId: 'tem_owls',
  homeTeamName: 'Demo Hawks',
  awayTeamName: 'Demo Owls',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: 'sea_regular',
  startAt: '2027-04-10T17:00:00Z',
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  videoCount: 1
})
const detail = asGameDetail({
  nonMemberView: false,
  id: game.id,
  homeTeamId: game.homeTeamId,
  awayTeamId: game.awayTeamId,
  homeTeamName: game.homeTeamName,
  awayTeamName: game.awayTeamName,
  seasonId: game.seasonId,
  startAt: game.startAt,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  ingestMessage: null,
  videos: []
})
const hawks = asPublicGroup({
  id: 'tem_hawks',
  kind: 'team',
  name: 'Demo Hawks',
  imageUrl: null,
  locality: null
})

describe('stack transitions in the actual app', () => {
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)
  const query = AccessibilityInfo.isReduceMotionEnabled
  const subscribe = AccessibilityInfo.addEventListener

  beforeEach(() => {
    // Motion on: these cases are about the transitions themselves.
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Fan',
        isAdmin: false
      })
    proto.myRoles = async () => {
      throw new Error('offline')
    }
    proto.hasNotifications = async () => false
    proto.teams = async () => [team]
    proto.seasons = async () => []
    proto.ownGroups = async () => []
    proto.follows = async () => []
    proto.recentGame = async () => null
    proto.liveNow = async () => []
    proto.games = async () => [game]
    proto.teamGames = async () => [game]
    proto.game = async () => detail
    proto.roster = async () => [
      asRosterEntry({
        userId: playerId,
        gumboId: 201,
        shortName: 'Alex L',
        jersey: null,
        positions: [],
        isPlayer: true,
        role: 'member',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null,
        avatarUrl: null
      })
    ]
    proto.teamStats = async () => []
    proto.teamPitchingStats = async () => []
    proto.standings = async () => []
    proto.seasonTeams = async () => [team]
    proto.player = async () =>
      asPlayerDetail({
        userId: playerId,
        name: 'Alex L',
        teams: [
          {
            teamId: team.id,
            teamName: team.name,
            logoUrl: null,
            seasonId: null,
            seasonName: null,
            seasonYear: null,
            jersey: null,
            positions: [],
            current: true
          }
        ]
      })
    proto.playerHighlights = async () => ({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    })
    proto.group = async () =>
      asGroupDetail({
        nonMemberView: false,
        canViewPrivate: true,
        group: hawks,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false
      })
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    Object.defineProperties(proto, originals)
    AccessibilityInfo.isReduceMotionEnabled = query
    AccessibilityInfo.addEventListener = subscribe
    window.history.replaceState(null, '', '/')
  })

  const settle = async (ms = 80): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }
  /** Long enough for any push or cover to finish. */
  const rest = async (): Promise<void> => {
    await settle(600)
  }
  const controls = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="tab"], [role="link"]'
    )
  ]
  const find = (label: string): HTMLElement | undefined =>
    controls().find(node => node.getAttribute('aria-label') === label) ??
    controls().find(node =>
      (node.getAttribute('aria-label') ?? '').includes(label)
    )
  /** Presses inside the top scene only: the one taking touches. */
  const press = async (label: string): Promise<void> => {
    const node = find(label)
    expect(node, label).not.equals(undefined)
    await act(async () => {
      node!.click()
    })
    await settle()
  }
  const pressIn = async (list: string, label: string): Promise<void> => {
    const node = document.querySelector<HTMLElement>(
      `[data-scene-role="incoming"] [aria-label="${list}"] [aria-label="${label}"], [data-scene-role="top"] [aria-label="${list}"] [aria-label="${label}"]`
    )
    expect(node, `${list} ${label}`).not.equals(null)
    await act(async () => {
      node!.click()
    })
    await settle()
  }
  const pressNav = async (label: string): Promise<void> => {
    const node = document.querySelector<HTMLElement>(
      `[role="tablist"]:not([aria-label]) [aria-label="${label}"]`
    )
    expect(node, label).not.equals(null)
    await act(async () => {
      node!.click()
    })
    await settle()
  }
  const scenes = (): Array<{ key: string; role: string; node: HTMLElement }> =>
    [...document.querySelectorAll<HTMLElement>('[data-scene]')].map(node => ({
      key: node.dataset.scene ?? '',
      role: node.dataset.sceneRole ?? '',
      node
    }))
  const roles = (): string[] => scenes().map(scene => scene.role)
  const navigator = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-swipe-back]')!
  const back = async (): Promise<void> => {
    await act(async () => {
      const done = new Promise(resolve => {
        window.addEventListener('popstate', resolve, { once: true })
      })
      window.history.back()
      await done
    })
    await settle(40)
  }
  const forward = async (): Promise<void> => {
    await act(async () => {
      const done = new Promise(resolve => {
        window.addEventListener('popstate', resolve, { once: true })
      })
      window.history.forward()
      await done
    })
    await settle(40)
  }

  async function render(): Promise<() => Promise<void>> {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    await rest()
    return async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  }
  async function openTeamPlayer(): Promise<void> {
    await press('Demo Hawks')
    await rest()
    await pressIn('Team sections', 'Team')
    await press('Alex L')
  }

  it('slides a push in and plays it back for the chevron (U12)', async () => {
    const cleanup = await render()
    try {
      await press('Demo Hawks')
      expect(roles().sort()).deep.equals(['incoming', 'outgoing'])
      await rest()
      expect(roles()).deep.equals(['top'])
      await pressIn('Team sections', 'Team')
      await press('Alex L')
      const player = scenes().find(scene => scene.role === 'incoming')
      expect(player?.key).match(/player/)
      await rest()
      await press('Back')
      expect(scenes().find(scene => scene.role === 'outgoing')?.key).match(
        /player/
      )
      await rest()
      expect(window.location.search).equals('?tab=team')
      expect(roles()).deep.equals(['top'])
    } finally {
      await cleanup()
    }
  })

  it('plays browser Back and Forward, also between one-frame stacks (U12)', async () => {
    const cleanup = await render()
    try {
      await openTeamPlayer()
      await rest()
      await back()
      expect(scenes().find(scene => scene.role === 'outgoing')?.key).match(
        /player/
      )
      await rest()
      await forward()
      // Both stacks hold one frame: the player replaced the team.
      expect(scenes().find(scene => scene.role === 'incoming')?.key).match(
        /player/
      )
      expect(scenes().find(scene => scene.role === 'outgoing')?.key).match(
        /team/
      )
      await rest()
    } finally {
      await cleanup()
    }
  })

  it('keeps the screen when Back only undoes a pill change (U12)', async () => {
    const cleanup = await render()
    try {
      await openTeamPlayer()
      await rest()
      const before = scenes()
      await pressIn('Player sections', 'Stats')
      expect(scenes().map(scene => scene.node)).deep.equals(
        before.map(scene => scene.node)
      )
      await back()
      expect(roles()).deep.equals(['top'])
      expect(scenes()[0].node).equals(before[0].node)
    } finally {
      await cleanup()
    }
  })

  it('keeps the game when Back walks a pill on the same game further down (U12)', async () => {
    const cleanup = await render()
    try {
      // All on Home's stack: a game route always lands on Home, so from
      // another tab this Back would be a move across tabs.
      await press('Demo Hawks')
      await rest()
      await pressIn('Team sections', 'Schedule')
      await press('Demo Owls')
      await rest()
      await press('Demo Hawks')
      await rest()
      await pressIn('Team sections', 'Schedule')
      await press('Demo Owls')
      await rest()
      const game = scenes()
      expect(game).has.length(1)
      expect(game[0].key).match(/^home:game:.*game_demo.*#0$/)
      await pressIn('Game sections', 'Box score')
      await back()
      expect(roles()).deep.equals(['top'])
      expect(scenes()[0].node).equals(game[0].node)
    } finally {
      await cleanup()
    }
  })

  it('draws a Back the browser already previewed as settled (U12)', async () => {
    const cleanup = await render()
    const descriptor = Object.getOwnPropertyDescriptor(
      window.PopStateEvent.prototype,
      'hasUAVisualTransition'
    )
    try {
      await openTeamPlayer()
      await rest()
      Object.defineProperty(
        window.PopStateEvent.prototype,
        'hasUAVisualTransition',
        { configurable: true, get: () => true }
      )
      await back()
      expect(roles()).deep.equals(['top'])
    } finally {
      if (descriptor == null)
        delete (
          window.PopStateEvent.prototype as { hasUAVisualTransition?: boolean }
        ).hasUAVisualTransition
      else
        Object.defineProperty(
          window.PopStateEvent.prototype,
          'hasUAVisualTransition',
          descriptor
        )
      await cleanup()
    }
  })

  it('animates a navbar pop to the root, and not a tab switch (U12)', async () => {
    const cleanup = await render()
    try {
      await openTeamPlayer()
      await rest()
      await pressNav('Videos')
      expect(roles()).deep.equals(['top'])
      await rest()
      await pressNav('Home')
      expect(roles()).deep.equals(['top'])
      await rest()
      await pressNav('Home')
      expect(roles().sort()).deep.equals(['incoming', 'outgoing'])
      expect(scenes().find(scene => scene.role === 'incoming')?.key).equals(
        'home:root'
      )
      await rest()
    } finally {
      await cleanup()
    }
  })

  it('changes a pill in place without a move or a remount (U12)', async () => {
    const cleanup = await render()
    try {
      await press('Demo Hawks')
      await rest()
      const before = scenes()
      await pressIn('Team sections', 'Stats')
      expect(roles()).deep.equals(['top'])
      expect(scenes()[0].node).equals(before[0].node)
    } finally {
      await cleanup()
    }
  })

  it('offers the drag back exactly where the chevron leaves the screen (U13)', async () => {
    const cleanup = await render()
    try {
      expect(navigator().dataset.swipeBack).equals('false')
      await press('Demo Hawks')
      expect(navigator().dataset.swipeBack).equals('true')
      await rest()
      await pressNav('Home')
      await rest()
      expect(navigator().dataset.swipeBack).equals('false')
    } finally {
      await cleanup()
    }
  })

  it('drops a replay’s late answer once the replay has slid out (U13)', async () => {
    let refuse!: (error: Error) => void
    const final = { ...detail, status: 'final' as const, replayable: true }
    proto.game = async () => final
    proto.health = async () => {
      throw new Error('offline')
    }
    proto.gameEvents = async () =>
      await new Promise((_resolve, reject) => {
        refuse = reject
      })
    window.history.replaceState(null, '', `/games/${game.id}`)
    const cleanup = await render()
    try {
      await press('Replay')
      await rest()
      expect(roles()).deep.equals(['top'])
      // Back before the replay has loaded.
      await back()
      // Its load fails while it slides out: it would have popped the game the
      // reader just went back to.
      await act(async () => {
        refuse(new Error('offline'))
        await Promise.resolve()
      })
      await rest()
      expect(scenes().map(scene => scene.key)).deep.equals([
        `home:game:${game.id}#0`
      ])
      expect(window.location.pathname).equals(`/games/${game.id}`)
    } finally {
      await cleanup()
    }
  })

  /**
   * An administrator on the player's Settings, with the server's answer to
   * "Remove from Demo Hawks" held until `answer`.
   */
  async function holdRemoval(): Promise<{
    answer: () => Promise<void>
    confirm: () => Promise<void>
  }> {
    let answer!: (reply: { removed: boolean }) => void
    proto.myRoles = async () => ({
      teams: { [team.id]: ['admin'] },
      guardianOf: []
    })
    proto.personProfile = async () =>
      asPersonProfile({
        context: { kind: 'team', id: team.id, name: team.name },
        person: {
          userId: playerId,
          gumboId: 201,
          shortName: 'Alex L',
          fullName: 'Alex Lee',
          avatarUrl: null,
          canHoldRoles: true
        },
        guardianOf: [],
        sections: [],
        viewer: { manages: true, admin: true }
      })
    proto.removePerson = async () =>
      await new Promise(resolve => {
        answer = resolve
      })
    // Named by its text, as the confirmation's button is.
    const byText = async (text: string): Promise<void> => {
      const node = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(button => button.textContent?.startsWith(text) === true)
      expect(node, text).not.equals(undefined)
      await act(async () => {
        node!.click()
      })
      await settle()
    }
    return {
      confirm: async () => {
        await press('Player settings')
        await rest()
        await byText('Remove from Demo Hawks')
        await byText('Remove Alex L')
      },
      answer: async () => {
        await act(async () => {
          answer({ removed: true })
          await Promise.resolve()
        })
        await rest()
      }
    }
  }
  const here = (): string => window.location.pathname + window.location.search

  it('drops a removal’s late answer once the player has slid out (U13)', async () => {
    const removal = await holdRemoval()
    const cleanup = await render()
    try {
      // A player, their team again from Teams, and the player once more:
      // the stack the late answer would cut short.
      await openTeamPlayer()
      await rest()
      await pressIn('Player sections', 'Teams')
      await press('Demo Hawks')
      await rest()
      await pressIn('Team sections', 'Team')
      await press('Alex L')
      await rest()
      await removal.confirm()
      // Back to the team before the server answers.
      await press('Back')
      expect(window.location.pathname).equals(`/teams/${team.id}`)
      const atTeam = here()
      await removal.answer()
      // Its answer would have taken the player beneath the team away with
      // the one that slid out.
      expect(here()).equals(atTeam)
      await press('Back')
      await rest()
      expect(window.location.pathname).equals(`/players/${playerId}`)
      expect(scenes().map(scene => scene.key)[0]).contains(':player:')
    } finally {
      await cleanup()
    }
  })

  it('keeps a removal’s answer for the player after a pill change (U13)', async () => {
    const removal = await holdRemoval()
    const cleanup = await render()
    try {
      await openTeamPlayer()
      await rest()
      await removal.confirm()
      // The same screen, its frame written anew by the pill.
      await pressIn('Player sections', 'Videos')
      await rest()
      await removal.answer()
      // Back to the team's roster, which the player is no longer on.
      expect(window.location.pathname).equals(`/teams/${team.id}`)
      expect(scenes().map(scene => scene.key)).deep.equals([
        `home:team:${team.id}#0`
      ])
    } finally {
      await cleanup()
    }
  })

  it('draws the field preview as one immersive scene with no chrome (U13)', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App fieldPreview />)
      })
      await rest()
      expect(scenes().map(scene => scene.key)).deep.equals(['fieldPreview'])
      expect(navigator().dataset.swipeBack).equals('false')
      expect(document.querySelector('[data-chrome]')).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('never enables Android’s back gesture on the web (U22)', async () => {
    const cleanup = await render()
    try {
      expect(navigator().dataset.predictiveBack).equals('false')
      await openTeamPlayer()
      await rest()
      expect(navigator().dataset.predictiveBack).equals('false')
      await pressIn('Player sections', 'Stats')
      expect(navigator().dataset.predictiveBack).equals('false')
      await pressNav('Schedule')
      expect(navigator().dataset.predictiveBack).equals('false')
    } finally {
      await cleanup()
    }
  })
})
