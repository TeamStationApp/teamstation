import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asGameScheduling, type GameProposal } from '../../common/gameApprovals'
import type { CreateGroup } from '../../common/groupCreation'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  type GameSettingsResult,
  GameSettingsScreen
} from './GameSettingsScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function settle(milliseconds = 300): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  })
}
const home = asPublicGroup({
  id: 'team_home',
  kind: 'team',
  name: 'Demo Hawks',
  imageUrl: null,
  locality: {
    city: 'Demo City',
    region: 'Demo Region',
    country: 'US',
    timezone: 'UTC',
    placeId: null
  }
})
const away = asPublicGroup({ ...home, id: 'team_away', name: 'Demo Eagles' })
const replacement = asPublicGroup({
  ...home,
  id: 'team_replacement',
  name: 'Demo Comets'
})
const league = asPublicGroup({
  ...home,
  id: 'league_demo',
  name: 'Demo League',
  kind: 'league'
})
const game = {
  homeTeamId: home.id,
  awayTeamId: away.id,
  seasonId: 'season_demo',
  startAt: '2027-03-02T18:00:00.000Z',
  timezone: 'UTC',
  exhibition: false,
  venue: 'Demo Field',
  outsideTournament: null,
  status: 'scheduled' as const
}
function fixture(managed = [home.id, away.id, replacement.id]): {
  client: TeamStationClient
  sent: GameProposal[]
  created: CreateGroup[]
  saved: GameSettingsResult[]
  withdrawn: string[]
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const sent: GameProposal[] = []
  const created: CreateGroup[] = []
  const saved: GameSettingsResult[] = []
  const withdrawn: string[] = []
  client.gameScheduling = async () =>
    asGameScheduling({
      game,
      version: 'a'.repeat(64),
      canPropose: true,
      withdrawTeamIds: [home.id],
      administeredTeamIds: [home.id]
    })
  client.group = async ref => {
    const group =
      [home, away, replacement, league].find(group => group.id === ref.id) ??
      home
    return asGroupDetail({
      nonMemberView: false,
      group,
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage: managed.includes(group.id) || group.id === league.id
    })
  }
  client.discoverGroups = async () => [home, away, replacement]
  client.ownGroups = async () => [home, league]
  client.createGroup = async body => {
    created.push(body)
    return {
      id: 'team_placeholder',
      name: body.name,
      kind: 'team',
      imageUrl: null
    }
  }
  client.proposeGame = async body => {
    sent.push(body)
    return {
      id: 'request_demo',
      status: 'accepted',
      gameId: 'game_demo',
      proposedGameId: 'game_demo',
      replacesGameId: null
    }
  }
  client.withdrawFromGame = async (_id, id) => {
    withdrawn.push(id)
  }
  return { client, sent, created, saved, withdrawn }
}
async function mount(
  f: ReturnType<typeof fixture>,
  onCancel = (): void => {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GameSettingsScreen
          client={f.client}
          gameId="game_demo"
          onSaved={result => f.saved.push(result)}
          onCancel={onCancel}
        />
      </ThemeProvider>
    )
  })
  await settle()
}
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
  await settle(0)
}
async function fill(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

describe('separate game settings drafts and consent labels', () => {
  for (const status of ['declined', 'expired', 'withdrawn', 'superseded'])
    it(`keeps the draft and refuses success feedback when a lost-response retry finds its proposal ${status}`, async () => {
      const f = fixture([home.id])
      f.client.proposeGame = async body => {
        f.sent.push(body)
        if (f.sent.length === 1) throw new Error('Response connection lost')
        return {
          id: 'request_demo',
          status,
          gameId: null,
          proposedGameId: 'game_reserved',
          replacesGameId: null
        }
      }
      await mount(f)
      await fill('Venue (optional)', 'Demo Retry Field')
      await press('Send Game Proposal')
      await press('Send Game Proposal')
      expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
      expect(f.saved).length(0)
      expect(document.body.textContent).includes('This proposal is closed.')
      expect(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Venue (optional)"]'
        )!.value
      ).equals('Demo Retry Field')
    })
  it('defaults a new opponent to an administered participating team even when a league is listed first', async () => {
    const f = fixture()
    f.client.ownGroups = async () => [league, home]
    await mount(f)
    await press('Change Demo Eagles')
    await press('Create a placeholder')
    await fill('Placeholder name', 'Demo Default Opponent')
    await press('Use this placeholder')
    await press('Save')
    expect(f.created[0].custodian).deep.equals({ kind: 'team', id: home.id })
  })
  it('refuses a viewer edit without claiming the scheduled game is canceled', async () => {
    const f = fixture([])
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game,
        version: 'a'.repeat(64),
        canPropose: false,
        withdrawTeamIds: [],
        administeredTeamIds: []
      })
    await mount(f)
    expect(button('Send Game Proposal').getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(button('Swap home and away').getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(document.body.textContent).includes(
      'You need administrator access to change this game.'
    )
    expect(document.body.textContent).not.includes('This canceled game')
    expect(document.body.textContent).not.includes('Withdraw Demo')
    await press('Send Game Proposal')
    expect(f.sent).length(0)
    expect(f.created).length(0)
  })
  it('ignores an older search result after the query has changed', async () => {
    const f = fixture()
    let resolveOld!: (groups: Array<typeof home>) => void
    f.client.discoverGroups = async (_kind, query) =>
      query === 'Comets'
        ? [replacement]
        : await new Promise(resolve => {
            resolveOld = resolve
          })
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    await fill('Find a team', 'Comets')
    await settle()
    expect(button('Choose Demo Comets')).not.equals(null)
    await act(async () => {
      resolveOld([home])
    })
    expect(document.body.textContent).not.includes('Choose Demo Hawks')
    expect(f.sent).length(0)
  })

  it('ignores a team detail response after its picker has closed', async () => {
    const f = fixture()
    const normalGroup = f.client.group.bind(f.client)
    let resolveChoice!: (
      detail: Awaited<ReturnType<TeamStationClient['group']>>
    ) => void
    f.client.group = async ref =>
      ref.id === replacement.id
        ? await new Promise(resolve => {
            resolveChoice = resolve
          })
        : await normalGroup(ref)
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    await press('Choose Demo Comets')
    await press('Close team picker')
    await act(async () => {
      resolveChoice(await normalGroup({ kind: 'team', id: replacement.id }))
    })
    expect(button('Change Demo Eagles')).not.equals(null)
    expect(document.body.textContent).not.includes('Demo Comets')
    expect(f.sent).length(0)
  })

  it('keeps a failed team selection retryable in the current picker', async () => {
    const f = fixture()
    const normalGroup = f.client.group.bind(f.client)
    let failed = false
    f.client.group = async ref => {
      if (ref.id === replacement.id && !failed) {
        failed = true
        throw new Error('Selected team is unavailable')
      }
      return await normalGroup(ref)
    }
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    await press('Choose Demo Comets')
    expect(document.body.textContent).includes('Selected team is unavailable')
    await press('Choose Demo Comets')
    expect(button('Change Demo Comets')).not.equals(null)
    expect(f.sent).length(0)
  })

  it('recovers managing-group lookup and offers only administered groups for a placeholder', async () => {
    const f = fixture([home.id])
    f.client.ownGroups = async () => {
      throw new Error('Managing groups unavailable')
    }
    await mount(f)
    await press('Change Demo Eagles')
    await press('Create a placeholder')
    expect(document.body.textContent).includes('Managing groups unavailable')
    expect(button('Use this placeholder').getAttribute('aria-disabled')).equals(
      'true'
    )
    f.client.ownGroups = async () => [home, away, league]
    await press('Create a placeholder')
    expect(button('Managed by Demo Hawks')).not.equals(null)
    expect(button('Managed by Demo League')).not.equals(null)
    expect(document.body.textContent).not.includes('Managed by Demo Eagles')
    expect(f.created).length(0)
  })

  it('retries withdrawal after an error without submitting the unsaved draft', async () => {
    const f = fixture()
    let attempts = 0
    f.client.withdrawFromGame = async (_id, teamId) => {
      attempts++
      if (attempts === 1) throw new Error('Withdrawal unavailable')
      f.withdrawn.push(teamId)
    }
    await mount(f)
    await fill('Venue (optional)', 'Unsaved Field')
    await press('Withdraw Demo Hawks from game')
    await press('Confirm withdrawal')
    expect(document.body.textContent).includes('Withdrawal unavailable')
    expect(f.saved).length(0)
    await press('Confirm withdrawal')
    expect(f.withdrawn).deep.equals([home.id])
    expect(f.sent).length(0)
    expect(f.saved[0].status).equals('withdrawn')
  })

  it('reloads a stale edit before permitting a new proposal against the new version', async () => {
    const f = fixture()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      throw new Error('The game changed. Review the current schedule.')
    }
    await mount(f)
    await fill('Venue (optional)', 'Stale Field')
    await press('Save')
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: { ...game, venue: 'Latest Field' },
        version: 'b'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await press('Reload game settings')
    await settle()
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Venue (optional)"]'
      )!.value
    ).equals('Latest Field')
    await press('Save')
    expect(f.sent[1].expected).equals('b'.repeat(64))
    expect(f.sent[1].idempotencyKey).not.equals(f.sent[0].idempotencyKey)
  })
  it('loads persisted values and swaps only the local preview until Save', async () => {
    const f = fixture()
    await mount(f)
    expect(document.body.textContent).includes('Game Settings')
    expect(document.body.textContent).not.includes('Choose a different season')
    expect(document.body.textContent).not.includes('Retry teams')
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Time"]')!
        .value
    ).equals('18:00')
    await press('Swap home and away')
    expect(f.sent).length(0)
    const names = document.body.textContent!
    expect(names.indexOf('Demo Hawks')).lessThan(names.indexOf('Demo Eagles'))
    await fill('Venue (optional)', 'Demo New Field')
    await press('Exhibition: Off')
    await press('Save')
    expect(f.sent).length(1)
    expect(f.sent[0].game).includes({
      homeTeamId: away.id,
      awayTeamId: home.id,
      exhibition: true,
      venue: 'Demo New Field',
      timezone: 'UTC'
    })
    expect(f.sent[0]).includes({
      expected: 'a'.repeat(64),
      gameId: 'game_demo'
    })
    expect(f.saved[0].status).equals('accepted')
  })
  it('Cancel discards every draft without creating a team or proposing a game', async () => {
    const f = fixture()
    let canceled = 0
    await mount(f, () => canceled++)
    await fill('Date', '2027-03-05')
    await press('Swap home and away')
    await press('Cancel')
    expect(canceled).equals(1)
    expect(f.sent).length(0)
    expect(f.created).length(0)
  })
  it('uses replacement current permissions and names the required approving team', async () => {
    const f = fixture([home.id, away.id])
    f.client.proposeGame = async body => {
      f.sent.push(body)
      return {
        id: 'request_pending',
        status: 'pending',
        gameId: 'game_demo',
        proposedGameId: 'game_demo',
        replacesGameId: null
      }
    }
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    await press('Choose Demo Comets')
    expect(document.body.textContent).includes(
      'An admin of Demo Comets must approve changes.'
    )
    expect(f.sent).length(0)
    await press('Send Game Proposal')
    expect(f.sent[0].game.awayTeamId).equals(replacement.id)
    expect(f.saved[0].status).equals('pending')
  })
  it('prevents duplicate opponents and invalid times before any mutation', async () => {
    const f = fixture()
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    await press('Choose Demo Hawks')
    expect(button('Save').getAttribute('aria-disabled')).equals('true')
    await press('Change Demo Hawks')
    await settle()
    await press('Choose Demo Eagles')
    await fill('Date', 'not-a-date')
    await press('Save')
    expect(document.querySelector('[role="alert"]')).not.equals(null)
    expect(f.sent).length(0)
    expect(f.created).length(0)
  })
  it('preserves drafts on error and reuses the identical retry key', async () => {
    const f = fixture()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      if (f.sent.length === 1) throw new Error('Temporary game error')
      return {
        id: 'request_retry',
        status: 'accepted',
        gameId: 'game_demo',
        proposedGameId: 'game_demo',
        replacesGameId: null
      }
    }
    await mount(f)
    await fill('Venue (optional)', 'Demo Retry Field')
    await press('Save')
    expect(f.saved).length(0)
    expect(document.body.textContent).includes('Temporary game error')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Venue (optional)"]'
      )!.value
    ).equals('Demo Retry Field')
    await press('Save')
    expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
    expect(f.saved).length(1)
  })
  it('blocks a duplicate submit while the first request is in flight', async () => {
    const f = fixture()
    let resolveRequest!: (
      value: Awaited<ReturnType<TeamStationClient['proposeGame']>>
    ) => void
    f.client.proposeGame = async body => {
      f.sent.push(body)
      return await new Promise(resolve => {
        resolveRequest = resolve
      })
    }
    await mount(f)
    const save = button('Save')
    await press('Save')
    await act(async () => {
      save.click()
    })
    expect(f.sent).length(1)
    await act(async () => {
      resolveRequest({
        id: 'request_demo',
        status: 'accepted',
        gameId: 'game_demo',
        proposedGameId: 'game_demo',
        replacesGameId: null
      })
    })
    expect(f.saved).length(1)
  })
  it('does not navigate a later screen when submission finishes after unmount', async () => {
    const f = fixture()
    let resolveRequest!: (
      value: Awaited<ReturnType<TeamStationClient['proposeGame']>>
    ) => void
    f.client.proposeGame = async () =>
      await new Promise(resolve => {
        resolveRequest = resolve
      })
    await mount(f)
    await press('Save')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await act(async () => {
      resolveRequest({
        id: 'request_demo',
        status: 'accepted',
        gameId: 'game_demo',
        proposedGameId: 'game_demo',
        replacesGameId: null
      })
    })
    expect(f.saved).length(0)
  })
  it('creates a staged placeholder only on Save, with the selected managing group', async () => {
    const f = fixture()
    await mount(f)
    await press('Change Demo Eagles')
    await press('Create a placeholder')
    await fill('Placeholder name', 'Demo Nomads')
    await press('Managed by Demo League')
    await press('Use this placeholder')
    expect(f.created).length(0)
    expect(f.sent).length(0)
    expect(document.body.textContent).includes('Demo Nomads')
    await press('Save')
    expect(f.created).length(1)
    expect(f.created[0]).includes({ name: 'Demo Nomads', external: true })
    expect(f.created[0].custodian).deep.equals({
      kind: 'league',
      id: league.id
    })
    expect(f.sent[0].game.awayTeamId).equals('team_placeholder')
  })
  it('retains the created placeholder when game submission must be retried', async () => {
    const f = fixture()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      throw new Error('Retry the game')
    }
    await mount(f)
    await press('Change Demo Eagles')
    await press('Create a placeholder')
    await fill('Placeholder name', 'Demo Retry Opponent')
    await press('Use this placeholder')
    await press('Save')
    await press('Save')
    expect(f.created).length(1)
    expect(f.sent).length(2)
    expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
  })
  it('requires a placeholder name and location when its managing group has none', async () => {
    const f = fixture()
    f.client.group = async () =>
      asGroupDetail({
        nonMemberView: false,
        group: { ...home, locality: null },
        parents: [],
        children: [],
        competingTeams: [],
        participatingSeasons: [],
        staff: [],
        games: [],
        canManage: true
      })
    f.client.ownGroups = async () => [home]
    await mount(f)
    await press('Change Demo Hawks')
    await press('Create a placeholder')
    await press('Use this placeholder')
    expect(document.body.textContent).includes('Enter a placeholder name.')
    await fill('Placeholder name', 'Demo Location Team')
    await press('Use this placeholder')
    expect(document.body.textContent).includes(
      'Enter a city and state or region.'
    )
    await fill('City', 'Demo City')
    await fill('State or region', 'Demo Region')
    await fill('Country', 'US')
    await press('Use this placeholder')
    expect(f.created).length(0)
    await press('Save')
    expect(f.created[0].locality).includes({
      city: 'Demo City',
      region: 'Demo Region',
      country: 'US'
    })
  })
  it('keeps a team lookup failure recoverable without touching the game', async () => {
    const f = fixture()
    f.client.discoverGroups = async () => {
      throw new Error('Lookup offline')
    }
    await mount(f)
    await press('Change Demo Eagles')
    await settle()
    expect(document.body.textContent).includes('Teams could not load.')
    await press('Close team picker')
    expect(f.sent).length(0)
  })
  it('makes load failures retryable and refuses edits on a canceled game', async () => {
    const f = fixture()
    f.client.gameScheduling = async () => {
      throw new Error('Game unavailable')
    }
    await mount(f)
    expect(document.body.textContent).includes('Game unavailable')
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: { ...game, status: 'cancelled' },
        version: 'a'.repeat(64),
        canPropose: false,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await press('Retry game settings')
    expect(button('Save').getAttribute('aria-disabled')).equals('true')
    expect(document.body.textContent).includes(
      'This canceled game cannot be changed.'
    )
  })
  it('withdraws only after confirmation, without proposing draft changes', async () => {
    const f = fixture()
    await mount(f)
    await fill('Venue (optional)', 'Unsaved Field')
    await press('Withdraw Demo Hawks from game')
    expect(f.withdrawn).length(0)
    await press('Keep game')
    expect(f.withdrawn).length(0)
    await press('Withdraw Demo Hawks from game')
    await press('Confirm withdrawal')
    expect(f.withdrawn).deep.equals([home.id])
    expect(f.sent).length(0)
    expect(f.saved[0].status).equals('withdrawn')
  })
})
