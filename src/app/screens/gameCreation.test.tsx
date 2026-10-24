import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asGameIntent } from '../../common/gameApprovals'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
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
