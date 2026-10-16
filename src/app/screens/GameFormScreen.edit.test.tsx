import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import { asGameScheduling, type GameProposal } from '../../common/gameApprovals'
import type { CreateGroup } from '../../common/groupCreation'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { pressSchedule, typeSchedule } from '../../test/eventScheduleDom'
import {
  fill,
  find,
  mount as mountElement,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { GameFormScreen, type GameSettingsResult } from './GameFormScreen'

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
  anchors: Array<{ teamId?: string; seasonId?: string }>
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const sent: GameProposal[] = []
  const created: CreateGroup[] = []
  const saved: GameSettingsResult[] = []
  const withdrawn: string[] = []
  const anchors: Array<{ teamId?: string; seasonId?: string }> = []
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
  client.relatedTeams = async anchor => {
    anchors.push(anchor)
    return [home, away, replacement]
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
  return { client, sent, created, saved, withdrawn, anchors }
}
async function mount(
  f: ReturnType<typeof fixture>,
  onCancel = (): void => {}
): Promise<void> {
  await mountElement(
    <GameFormScreen
      client={f.client}
      mode={{ kind: 'edit', gameId: 'game_demo' }}
      onSaved={result => f.saved.push(result)}
      onCancel={onCancel}
    />
  )
  await settle()
}
function button(label: string): HTMLElement {
  const found = find(label)
  expect(found, label).not.equals(undefined)
  return found!
}
const disabled = (label: string): boolean =>
  button(label).getAttribute('aria-disabled') === 'true'
/** Opens the selector for the side holding this team, and waits for its list. */
async function change(team: string): Promise<void> {
  await press(`${team}, ${team === 'Demo Hawks' ? 'Home' : 'Away'}`)
  await settle()
}
async function placeholder(name: string): Promise<void> {
  await press('Create Placeholder Team')
  await fill('Team name', name)
  await press('Continue')
  await press('Skip')
  await press('Skip')
}
const venue = (): string =>
  document.querySelector<HTMLInputElement>(
    'input[aria-label="Venue name (optional)"]'
  )!.value

describe('game settings in the shared game scene', () => {
  afterEach(unmount)
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
      await fill('Venue name (optional)', 'Demo Retry Field')
      await press('Save')
      await press('Save')
      expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
      expect(f.saved).length(0)
      expect(text()).includes('This proposal is closed.')
      expect(venue()).equals('Demo Retry Field')
    })
  it('keeps a new placeholder with an administered participating team even when a league is listed first', async () => {
    const f = fixture()
    f.client.ownGroups = async () => [league, home]
    await mount(f)
    await change('Demo Eagles')
    await press('Create Placeholder Team')
    expect(text()).includes('Kept by Demo Hawks')
    await fill('Team name', 'Demo Default Opponent')
    await press('Continue')
    await press('Skip')
    await press('Skip')
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
    expect(disabled('Save')).equals(true)
    expect(disabled('Swap home and away')).equals(true)
    // Neither team row opens the selector.
    expect(find('Demo Eagles, Away')).equals(undefined)
    expect(text()).includes(
      'You need administrator access to change this game.'
    )
    expect(text()).not.includes('This canceled game')
    expect(text()).not.includes('Withdraw Demo')
    await press('Save')
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
    await change('Demo Eagles')
    await fill('Search all teams', 'Co')
    await settle()
    await fill('Search all teams', 'Comets')
    await settle()
    expect(button('Choose Demo Comets')).not.equals(null)
    await act(async () => {
      resolveOld([home])
    })
    expect(text()).not.includes('Choose Demo Hawks')
    expect(f.sent).length(0)
  })
  it('ignores a team detail response after its selector has closed', async () => {
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
    await change('Demo Eagles')
    await press('Choose Demo Comets')
    await press('Cancel team selector')
    await act(async () => {
      resolveChoice(await normalGroup({ kind: 'team', id: replacement.id }))
    })
    expect(button('Demo Eagles, Away')).not.equals(null)
    expect(text()).not.includes('Demo Comets')
    expect(f.sent).length(0)
  })
  it('keeps a failed team selection retryable in the open selector', async () => {
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
    await change('Demo Eagles')
    await press('Choose Demo Comets')
    expect(text()).includes('Selected team is unavailable')
    await press('Choose Demo Comets')
    expect(button('Demo Comets, Away')).not.equals(null)
    expect(f.sent).length(0)
  })
  it('suggests around the side that stays, and the game’s season', async () => {
    const f = fixture()
    await mount(f)
    await change('Demo Eagles')
    expect(f.anchors.at(-1)).deep.equals({
      teamId: home.id,
      seasonId: 'season_demo'
    })
    // The team that stays is never offered for the other side.
    expect(find('Choose Demo Hawks')).equals(undefined)
    await press('Cancel team selector')
    await change('Demo Hawks')
    expect(f.anchors.at(-1)).deep.equals({
      teamId: away.id,
      seasonId: 'season_demo'
    })
  })
  it('offers no placeholder when the managing groups cannot load', async () => {
    const f = fixture([home.id])
    f.client.ownGroups = async () => {
      throw new Error('Managing groups unavailable')
    }
    await mount(f)
    await change('Demo Eagles')
    // Not loading is not the same as managing nothing.
    expect(text()).includes(
      'Who may keep a placeholder could not load. Cancel and open this again to retry.'
    )
    expect(text()).not.includes('You need to manage a team or season')
    expect(f.created).length(0)
  })
  it('asks again for the managing groups when the selector reopens after a failure', async () => {
    const f = fixture([home.id])
    let asked = 0
    f.client.ownGroups = async () => {
      asked++
      // At mount, and again as the selector first opens.
      if (asked <= 2) throw new Error('Managing groups unavailable')
      return [home, league]
    }
    await mount(f)
    await change('Demo Eagles')
    expect(text()).includes('could not load')
    await press('Cancel team selector')
    await settle(400)
    await change('Demo Eagles')
    expect(asked).equals(3)
    expect(text()).not.includes('could not load')
    expect(disabled('Create Placeholder Team')).equals(false)
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
    await fill('Venue name (optional)', 'Unsaved Field')
    await press('Withdraw Demo Hawks')
    await press('Confirm withdrawal')
    expect(text()).includes('Withdrawal unavailable')
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
    await fill('Venue name (optional)', 'Stale Field')
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
    expect(venue()).equals('Latest Field')
    await press('Save')
    expect(f.sent[1].expected).equals('b'.repeat(64))
    expect(f.sent[1].idempotencyKey).not.equals(f.sent[0].idempotencyKey)
  })
  it('shows a failed reload with its retry instead of the stale form', async () => {
    const f = fixture()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      throw new Error('The game changed. Review the current schedule.')
    }
    await mount(f)
    await press('Save')
    f.client.gameScheduling = async () => {
      throw new Error('Game unavailable')
    }
    await press('Reload game settings')
    await settle()
    expect(text()).includes('Game unavailable')
    expect(find('Save')).equals(undefined)
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: { ...game, venue: 'Latest Field' },
        version: 'b'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await press('Retry game settings')
    await settle()
    expect(venue()).equals('Latest Field')
    expect(disabled('Save')).equals(false)
  })
  it('loads saved values and swaps only the local draft until Save', async () => {
    const f = fixture()
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: { ...game, exhibition: true },
        version: 'a'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await mount(f)
    expect(
      document.querySelector('[role="heading"], [aria-level]')?.textContent
    ).equals('Game Settings')
    expect(text()).not.includes('Choose a different season')
    expect(
      document.querySelector('[data-testid="event-schedule-time"]')?.textContent
    ).includes(
      new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(game.startAt))
    )
    const exhibition = document.querySelector<HTMLInputElement>(
      'input[aria-label="Exhibition"]'
    )!
    expect(exhibition.checked).equals(true)
    await press('Swap home and away')
    expect(f.sent).length(0)
    expect(button('Demo Eagles, Home')).not.equals(null)
    expect(button('Demo Hawks, Away')).not.equals(null)
    await fill('Venue name (optional)', 'Demo New Field')
    await act(async () => {
      exhibition.click()
    })
    await press('Save')
    expect(f.sent).length(1)
    expect(f.sent[0].game).includes({
      homeTeamId: away.id,
      awayTeamId: home.id,
      exhibition: false,
      venue: 'Demo New Field',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    expect(f.sent[0]).includes({
      expected: 'a'.repeat(64),
      gameId: 'game_demo',
      initiatingTeamId: home.id
    })
    expect(f.sent[0].sender).deep.equals({ kind: 'team', id: home.id })
    expect(f.saved[0].status).equals('accepted')
  })
  it('sends address and exact unchanged off-grid start/end instants through game approval', async () => {
    const f = fixture()
    const startAt = '2027-04-11T06:32:42.123Z'
    const endAt = '2027-04-11T09:32:42.123Z'
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: {
          ...game,
          startAt,
          endAt,
          address: '1 Demo Way',
          latitude: 0,
          longitude: 0
        },
        version: 'a'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await mount(f)
    await fill('Venue address (optional)', '2 Demo Way')
    await press('Save')
    expect(f.sent[0].game).includes({
      startAt,
      endAt,
      address: '2 Demo Way',
      latitude: null,
      longitude: null
    })
  })
  it('adds an end time to a future game on its loaded local start date', async () => {
    const f = fixture()
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: {
          ...game,
          startAt: '2037-07-02T02:00:00.000Z',
          timezone: 'America/Los_Angeles'
        },
        version: 'a'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await mount(f)
    await press('Set end time')
    expect(
      document.querySelector('[data-testid="event-schedule-endTime"]')
    ).not.equals(null)
    await press('Save')
    expect(f.sent[0].game.startAt).equals('2037-07-02T02:00:00.000Z')
    expect(f.sent[0].game.endAt).equals('2037-07-02T05:00:00.000Z')
  })
  it('Cancel discards every draft without creating a team or proposing a game', async () => {
    const f = fixture()
    let canceled = 0
    await mount(f, () => canceled++)
    await fill('Date', '2027-03-05')
    await press('Swap home and away')
    await press('Demo Hawks, Away')
    await settle()
    await placeholder('Demo Nomads')
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
    await change('Demo Eagles')
    await press('Choose Demo Comets')
    expect(text()).includes(
      'An administrator, coach or assistant of Demo Comets must approve changes.'
    )
    expect(f.sent).length(0)
    await press('Save')
    expect(f.sent[0].game.awayTeamId).equals(replacement.id)
    expect(f.saved[0].status).equals('pending')
  })
  it('prevents invalid times before any mutation', async () => {
    const f = fixture()
    await mount(f)
    await pressSchedule('[data-testid="event-schedule-date"]')
    await typeSchedule('Year', 'invalid')
    expect(document.querySelector('[role="alert"]')).not.equals(null)
    expect(f.sent).length(0)
    expect(f.created).length(0)
    await pressSchedule('Cancel date picker')
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
    await fill('Venue name (optional)', 'Demo Retry Field')
    await press('Save')
    expect(f.saved).length(0)
    expect(text()).includes('Temporary game error')
    expect(venue()).equals('Demo Retry Field')
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
    await unmount()
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
  it('creates a staged placeholder only on Save, kept automatically by a team in the game', async () => {
    const f = fixture()
    await mount(f)
    await change('Demo Eagles')
    await placeholder('Demo Nomads')
    expect(f.created).length(0)
    expect(f.sent).length(0)
    expect(button('Demo Nomads, Away · Placeholder')).not.equals(null)
    // A placeholder not made yet is never what the other side suggests around.
    await change('Demo Hawks')
    expect(f.anchors.at(-1)).deep.equals({
      teamId: home.id,
      seasonId: 'season_demo'
    })
    await press('Cancel team selector')
    await press('Save')
    expect(f.created).length(1)
    expect(f.created[0]).includes({ name: 'Demo Nomads', external: true })
    expect(f.created[0].custodian).deep.equals({ kind: 'team', id: home.id })
    expect(f.created[0]).not.have.property('locality')
    expect(f.sent[0].game.awayTeamId).equals('team_placeholder')
  })
  it('retains the created placeholder when game submission must be retried', async () => {
    const f = fixture()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      throw new Error('Retry the game')
    }
    await mount(f)
    await change('Demo Eagles')
    await placeholder('Demo Retry Opponent')
    await press('Save')
    await press('Save')
    expect(f.created).length(1)
    expect(f.sent).length(2)
    expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
  })
  it('requires only a placeholder name; a location is optional', async () => {
    const f = fixture()
    await mount(f)
    await change('Demo Hawks')
    await press('Create Placeholder Team')
    expect(disabled('Continue')).equals(true)
    await fill('Team name', 'Demo Location Team')
    await press('Continue')
    await press('Skip')
    await press('Skip')
    await press('Save')
    expect(f.created[0].name).equals('Demo Location Team')
    expect(f.created[0]).not.have.property('locality')
  })
  it('keeps a team lookup failure recoverable without touching the game', async () => {
    const f = fixture()
    f.client.relatedTeams = async () => {
      throw new Error('Lookup offline')
    }
    await mount(f)
    await change('Demo Eagles')
    expect(text()).includes('Teams could not load.')
    await press('Cancel team selector')
    expect(f.sent).length(0)
  })
  it('makes load failures retryable and refuses edits on a canceled game', async () => {
    const f = fixture()
    f.client.gameScheduling = async () => {
      throw new Error('Game unavailable')
    }
    await mount(f)
    expect(text()).includes('Game unavailable')
    f.client.gameScheduling = async () =>
      asGameScheduling({
        game: { ...game, status: 'cancelled' },
        version: 'a'.repeat(64),
        canPropose: false,
        withdrawTeamIds: [home.id],
        administeredTeamIds: [home.id]
      })
    await press('Retry game settings')
    await settle()
    expect(disabled('Save')).equals(true)
    expect(text()).includes('This canceled game cannot be changed.')
  })
  it('withdraws only after confirmation, with small withdrawal labels, without proposing draft changes', async () => {
    const f = fixture()
    await mount(f)
    const label = [
      ...button('Withdraw Demo Hawks').querySelectorAll('div')
    ].find(node => node.textContent === 'Withdraw Demo Hawks')!
    expect(getComputedStyle(label).fontSize).equals('14px')
    await fill('Venue name (optional)', 'Unsaved Field')
    await press('Withdraw Demo Hawks')
    expect(f.withdrawn).length(0)
    await press('Keep game')
    expect(f.withdrawn).length(0)
    await press('Withdraw Demo Hawks')
    await press('Confirm withdrawal')
    expect(f.withdrawn).deep.equals([home.id])
    expect(f.sent).length(0)
    expect(f.saved[0].status).equals('withdrawn')
  })
})
