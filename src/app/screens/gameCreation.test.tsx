import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import {
  asGameIntent,
  asGameScheduling,
  type GameProposal
} from '../../common/gameApprovals'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import * as dom from '../../test/gameFormDom'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameFormScreen, type GameSettingsResult } from './GameFormScreen'
import { GameSchedulingControls, GroupGameSchedule } from './GroupGameSchedule'

let root: Root | undefined

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  await settle()
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 280))
  })
}
async function press(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="radio"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
  })
}
const team = asPublicGroup({
  id: 'team_demo',
  kind: 'team',
  name: 'Demo Hawks',
  locality: null,
  imageUrl: null
})
const away = asPublicGroup({
  ...team,
  id: 'team_away',
  name: 'Demo Eagles',
  external: true
})
const season = asPublicGroup({
  ...team,
  id: 'season_demo',
  kind: 'season',
  name: 'Demo Spring',
  startsOn: '2027-03-01',
  endsOn: '2027-05-31'
})
const game = asGameIntent({
  homeTeamId: team.id,
  awayTeamId: away.id,
  seasonId: null,
  startAt: '2029-07-01T19:00:00.000Z',
  venue: null,
  outsideTournament: null,
  status: 'scheduled'
})
function api(): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.discoverGroups = async () => [team, away]
  client.ownGroups = async () => [season]
  client.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group: ref.kind === 'season' ? season : ref.id === away.id ? away : team,
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage: true
    })
  client.gameScheduling = async () => ({
    game,
    version: 'a'.repeat(64),
    canPropose: true,
    withdrawTeamIds: [team.id],
    administeredTeamIds: [team.id],
    canSwap: false,
    plays: undefined
  })
  client.gameProposals = async () => []
  return client
}
describe('team game schedule recovery', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
  })
  it('renders pending changes and sender-only declined projection; deletion errors remain retryable', async () => {
    const client = api()
    let opened = ''
    let removed = false
    client.gameProposals = async () => [
      {
        requestId: 'request_demo',
        gameId: 'game_demo',
        game: { ...game, venue: 'Demo Field' },
        previous: game,
        status: 'declined',
        sentAt: game.startAt,
        canDelete: true,
        version: null
      }
    ]
    client.deleteDeclinedGame = async () => {
      throw new Error('Delete offline')
    }
    await mount(
      <GroupGameSchedule
        client={client}
        groupRef={{ kind: 'team', id: team.id }}
        onRequest={id => {
          opened = id
        }}
      />
    )
    await press('Open game proposal')
    expect(opened).equals('request_demo')
    await press('Delete declined entry')
    expect(document.body.textContent).includes('Delete offline')
    client.deleteDeclinedGame = async (_id, scope) => {
      expect(scope).deep.equals({ kind: 'team', id: team.id })
      removed = true
    }
    await press('Delete declined entry')
    expect(removed).equals(true)
    client.gameProposals = async () => {
      throw new Error('Load offline')
    }
    await press('Delete declined entry')
    await press('Retry game proposals')
    expect(document.body.textContent).includes('Load offline')
  })
  it('confirms unilateral withdrawal, retains the confirmation on error and refreshes current rights on success', async () => {
    const client = api()
    let edited = false
    let changed = false
    client.withdrawFromGame = async () => {
      throw new Error('Withdrawal offline')
    }
    await mount(
      <GameSchedulingControls
        client={client}
        gameId="game_demo"
        teamNames={{ [team.id]: team.name }}
        onEdit={() => {
          edited = true
        }}
        onChanged={() => {
          changed = true
        }}
      />
    )
    await press('Propose game change')
    expect(edited).equals(true)
    await press('Withdraw Demo Hawks from game')
    await press('Keep game')
    await press('Withdraw Demo Hawks from game')
    await press('Confirm withdrawal')
    expect(document.body.textContent).includes('Withdrawal offline')
    client.withdrawFromGame = async () => {}
    client.gameScheduling = async () => {
      throw new Error('Lost authority')
    }
    await press('Confirm withdrawal')
    expect(changed).equals(true)
    expect(document.body.textContent).not.includes('Propose game change')
  })
})

/** Create Game and Game Settings with a side left TBD. */
describe('a game whose team is TBD, created and changed', () => {
  afterEach(dom.unmount)

  const eagles = asPublicGroup({
    ...team,
    id: 'team_eagles',
    name: 'Demo Eagles'
  })
  interface Tbd {
    client: TeamStationClient
    sent: GameProposal[]
    saved: GameSettingsResult[]
    groups: string[]
    swaps: unknown[]
    created: number
  }
  function tbdApi(): Tbd {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const f: Tbd = {
      client,
      sent: [],
      saved: [],
      groups: [],
      swaps: [],
      created: 0
    }
    client.ownGroups = async () => [season, team]
    client.relatedTeams = async () => [team, eagles]
    client.discoverGroups = async () => [team, eagles]
    client.group = async ref => {
      f.groups.push(ref.id)
      if (ref.kind === 'team' && ![team.id, eagles.id].includes(ref.id))
        throw new Error(`No team ${ref.id}`)
      return asGroupDetail({
        nonMemberView: false,
        group:
          ref.kind === 'season' ? season : ref.id === eagles.id ? eagles : team,
        parents: [],
        children: [],
        competingTeams: ref.kind === 'season' ? [team, eagles] : [],
        participatingSeasons: [],
        staff: [],
        games: [],
        canManage: ref.id !== eagles.id
      })
    }
    client.createGroup = async () => {
      f.created++
      throw new Error('No placeholder is made for TBD')
    }
    client.proposeGame = async body => {
      f.sent.push(body)
      return {
        id: 'request_tbd',
        status: 'accepted',
        gameId: 'game_tbd',
        proposedGameId: 'game_tbd',
        replacesGameId: null
      }
    }
    client.swapGameSides = async (_gameId, read) => {
      f.swaps.push(read)
      throw new Error('An open game is never swapped alone')
    }
    return f
  }
  /** The scheduling answer of a game whose sides are as given, `''` open. */
  const scheduling = (
    homeTeamId: string,
    awayTeamId: string,
    rights: { canPropose: boolean; canSwap: boolean; withdraw: string[] }
  ): ReturnType<typeof asGameScheduling> =>
    asGameScheduling({
      game: {
        ...game,
        homeTeamId,
        awayTeamId,
        seasonId: season.id,
        startAt: '2029-07-01T19:00:00.000Z'
      },
      version: 'b'.repeat(64),
      canPropose: rights.canPropose,
      withdrawTeamIds: rights.withdraw,
      administeredTeamIds: rights.withdraw,
      canSwap: rights.canSwap,
      plays: { atBats: 0, innings: 0, playsDigest: 'digest', generation: 1 }
    })
  async function create(
    f: Tbd,
    source: { kind: 'team' | 'season'; id: string }
  ): Promise<void> {
    await dom.mount(
      <GameFormScreen
        client={f.client}
        mode={{ kind: 'create', source }}
        onSaved={result => f.saved.push(result)}
        onCancel={() => undefined}
      />
    )
    await dom.settle()
  }
  async function edit(f: Tbd): Promise<void> {
    await dom.mount(
      <GameFormScreen
        client={f.client}
        mode={{ kind: 'edit', gameId: 'game_tbd' }}
        onSaved={result => f.saved.push(result)}
        onCancel={() => undefined}
      />
    )
    await dom.settle()
  }
  const tbdRow = (): Element | null =>
    document.querySelector('[data-testid="team-tbd"]')
  const saveDisabled = (): boolean =>
    dom.find('Save')!.getAttribute('aria-disabled') === 'true'
  async function pick(side: string, label: string): Promise<void> {
    await dom.press(side)
    await dom.settle()
    await dom.press(label)
    await dom.settle()
  }

  it('saves a team page’s game with the opponent TBD, making no team, and names it in the notice', async () => {
    const f = tbdApi()
    await create(f, { kind: 'team', id: team.id })
    // The team's own side opens no selector, so it is never TBD.
    expect(dom.find('Demo Hawks, Home')).equals(undefined)
    expect(saveDisabled()).equals(true)
    await dom.press('Choose Away Team')
    await dom.settle()
    expect(tbdRow()).not.equals(null)
    await dom.press('TBD, Choose the team later')
    await dom.settle()
    expect(dom.find('TBD, Away · Team to be decided')).not.equals(undefined)
    expect(saveDisabled()).equals(false)
    await dom.press('Save')
    await dom.settle()
    expect(f.created).equals(0)
    expect(f.sent).length(1)
    expect(f.sent[0].sender).deep.equals({ kind: 'team', id: team.id })
    expect(f.sent[0].game).deep.include({
      homeTeamId: team.id,
      awayTeamId: null
    })
    expect(f.saved.map(result => result.notice)).deep.equals([
      'Game scheduled: Demo Hawks vs TBD'
    ])
  })

  it('replaces a TBD opponent with a team before Save', async () => {
    const f = tbdApi()
    await create(f, { kind: 'team', id: team.id })
    await pick('Choose Away Team', 'TBD, Choose the team later')
    await pick('TBD, Away · Team to be decided', 'Choose Demo Eagles')
    expect(dom.find('Demo Eagles, Away')).not.equals(undefined)
    await dom.press('Save')
    await dom.settle()
    expect(f.sent[0].game).deep.include({ awayTeamId: eagles.id })
  })

  it('saves a season page’s game with both sides TBD, as the season', async () => {
    const f = tbdApi()
    await create(f, { kind: 'season', id: season.id })
    await pick('Choose Home Team', 'TBD, Choose the team later')
    await pick('Choose Away Team', 'TBD, Choose the team later')
    expect(dom.text()).includes(
      'You can schedule this game for both season participants.'
    )
    await dom.press('Save')
    await dom.settle()
    expect(f.created).equals(0)
    expect(f.sent[0].sender).deep.equals({ kind: 'season', id: season.id })
    expect(f.sent[0].game).deep.include({
      homeTeamId: null,
      awayTeamId: null,
      seasonId: season.id
    })
    expect(f.saved[0].notice).equals(
      'Game scheduled: TBD vs TBD in Demo Spring'
    )
  })

  it('loads an open side as TBD in Game Settings, offers TBD only there, and sends the team assigned to it', async () => {
    const f = tbdApi()
    f.client.gameScheduling = async () =>
      scheduling(team.id, '', {
        canPropose: true,
        canSwap: true,
        withdraw: [team.id]
      })
    await edit(f)
    // Only the named side's team is read; nothing asks for a team ''.
    expect(f.groups.filter(id => id !== season.id)).deep.equals([team.id])
    expect(dom.find('TBD, Away · Team to be decided')).not.equals(undefined)
    expect(saveDisabled()).equals(false)
    await dom.press('Demo Hawks, Home')
    await dom.settle()
    expect(tbdRow()).equals(null)
    await dom.press('Cancel team selector')
    await dom.settle()
    await pick('TBD, Away · Team to be decided', 'Choose Demo Eagles')
    // Eagles is no team this person manages: it approves the change.
    expect(dom.text()).includes('Demo Eagles')
    await dom.press('Save')
    await dom.settle()
    expect(f.sent).length(1)
    expect(f.sent[0]).deep.include({
      sender: { kind: 'team', id: team.id },
      gameId: 'game_tbd'
    })
    expect(f.sent[0].game).deep.include({
      homeTeamId: team.id,
      awayTeamId: eagles.id
    })
    expect(f.saved[0].notice).equals(
      'Game changes saved: Demo Hawks vs Demo Eagles'
    )
  })

  it('sends a swap of an open game as a proposal, never a swap alone, and leaves a swapper without proposal rights no Save', async () => {
    const f = tbdApi()
    f.client.gameScheduling = async () =>
      scheduling(team.id, '', {
        canPropose: true,
        canSwap: true,
        withdraw: [team.id]
      })
    await edit(f)
    await dom.press('Swap home and away')
    await dom.settle()
    expect(dom.find('TBD, Home · Team to be decided')).not.equals(undefined)
    await dom.press('Save')
    await dom.settle()
    expect(f.swaps).length(0)
    expect(f.sent).length(1)
    expect(f.sent[0].game).deep.include({
      homeTeamId: null,
      awayTeamId: team.id
    })
    expect(f.saved[0].notice).equals('Game changes saved: TBD vs Demo Hawks')
    await dom.unmount()

    const scorer = tbdApi()
    scorer.client.gameScheduling = async () =>
      scheduling(team.id, '', {
        canPropose: false,
        canSwap: true,
        withdraw: []
      })
    await edit(scorer)
    expect(saveDisabled()).equals(true)
    await dom.press('Swap home and away')
    await dom.settle()
    expect(saveDisabled()).equals(true)
    expect(scorer.swaps).length(0)
    expect(scorer.sent).length(0)
  })

  it('changes a both-open season game as its season, and names one side', async () => {
    const f = tbdApi()
    f.client.gameScheduling = async () =>
      scheduling('', '', { canPropose: true, canSwap: false, withdraw: [] })
    await edit(f)
    expect(f.groups.filter(id => id !== season.id)).deep.equals([])
    await pick('TBD, Home · Team to be decided', 'Choose Demo Hawks')
    await dom.press('Save')
    await dom.settle()
    expect(f.sent[0].sender).deep.equals({ kind: 'season', id: season.id })
    expect(f.sent[0]).not.have.property('initiatingTeamId')
    expect(f.sent[0].game).deep.include({
      homeTeamId: team.id,
      awayTeamId: null
    })
    expect(f.saved[0].notice).equals('Game changes saved: Demo Hawks vs TBD')
  })
})
