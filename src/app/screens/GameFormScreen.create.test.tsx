import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import type { GameProposal } from '../../common/gameApprovals'
import type { CreateGroup } from '../../common/groupCreation'
import {
  asGroupDetail,
  asPublicGroup,
  type PublicGroup
} from '../../common/publicGroups'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { TEAM_GAME_NOTE } from './gameDraft'
import { GameFormScreen, type GameSettingsResult } from './GameFormScreen'

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
const third = asPublicGroup({ ...team, id: 'team_third', name: 'Demo Owls' })
const season = asPublicGroup({
  ...team,
  id: 'season_demo',
  kind: 'season',
  name: 'Demo Spring',
  startsOn: '2027-03-01',
  endsOn: '2027-05-31'
})
const proposal = (
  id: string,
  status = 'pending'
): Awaited<ReturnType<TeamStationClient['proposeGame']>> => ({
  id,
  status,
  gameId: null,
  proposedGameId: null,
  replacesGameId: null
})

interface Fixture {
  client: TeamStationClient
  sent: GameProposal[]
  created: CreateGroup[]
  saved: GameSettingsResult[]
  events: string[]
  anchors: Array<{ teamId?: string; seasonId?: string }>
  canceled: number[]
}
function api(
  manage: (ref: { kind: string; id: string }) => boolean = () => true,
  people: (ref: { kind: string; id: string }) => boolean = () => false
): Fixture {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const f: Fixture = {
    client,
    sent: [],
    created: [],
    saved: [],
    events: [],
    anchors: [],
    canceled: []
  }
  client.discoverGroups = async kind =>
    kind === 'season' ? [season] : [team, away, third]
  client.relatedTeams = async anchor => {
    f.anchors.push(anchor)
    return [team, away, third]
  }
  client.ownGroups = async () => [season, team]
  client.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group:
        ref.kind === 'season'
          ? season
          : ([team, away, third].find(group => group.id === ref.id) ?? team),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage: manage(ref),
      canManagePeople: people(ref)
    })
  client.proposeGame = async body => {
    f.sent.push(body)
    return proposal('request_demo')
  }
  client.createGroup = async body => {
    f.created.push(body)
    return {
      id: 'team_placeholder',
      name: body.name,
      kind: 'team',
      imageUrl: null
    }
  }
  return f
}
async function open(
  f: Fixture,
  source: { kind: 'team' | 'season'; id: string } = {
    kind: 'team',
    id: team.id
  }
): Promise<void> {
  await mount(
    <GameFormScreen
      client={f.client}
      mode={{ kind: 'create', source }}
      onSaved={result => f.saved.push(result)}
      onEventCreated={id => f.events.push(id)}
      onCancel={() => f.canceled.push(1)}
    />
  )
  await settle()
}
async function choose(side: 'Home' | 'Away', name: string): Promise<void> {
  await press(`Choose ${side} Team`)
  await settle()
  await press(`Choose ${name}`)
}
const disabled = (label: string): boolean =>
  find(label)?.getAttribute('aria-disabled') === 'true'
const arrival = (): string =>
  document.querySelector<HTMLInputElement>(
    '[aria-label="Arrival minutes (optional)"]'
  )!.value

describe('create game in the shared game scene', () => {
  it('lets a team coach propose a game and keeps a season source administrator-only', async () => {
    const f = api(
      () => false,
      ref => ref.kind === 'team' && ref.id === team.id
    )
    await open(f)
    await choose('Away', 'Demo Eagles')
    await press('Save')
    expect(f.sent[0].sender).deep.equals({ kind: 'team', id: team.id })
    await unmount()
    const seasonCoach = api(
      () => false,
      () => true
    )
    await open(seasonCoach, { kind: 'season', id: season.id })
    expect(text()).includes('administrator')
    expect(seasonCoach.sent).length(0)
  })
  afterEach(unmount)

  it('does not request opponent approval when team staff manage both selected teams', async () => {
    const f = api(
      () => false,
      ref => ref.kind === 'team'
    )
    await open(f)
    await choose('Away', 'Demo Eagles')
    expect(text()).not.includes('must approve this game')
    await press('Save')
    expect(f.sent[0].game).includes({
      homeTeamId: team.id,
      awayTeamId: away.id
    })
  })

  it('starts from the team as home, with the opponent to choose, the exhibition note and Save waiting', async () => {
    const f = api()
    await open(f)
    expect(
      document.querySelector('[role="heading"], [aria-level]')?.textContent
    ).equals('Create Game')
    // The source team's row opens nothing.
    expect(find('Demo Hawks, Home')).equals(undefined)
    expect(text()).includes('Demo Hawks')
    expect(find('Choose Away Team')).not.equals(undefined)
    // A team page's game is always a scrimmage or exhibition, in no season.
    expect(document.querySelector('input[aria-label="Exhibition"]')).equals(
      null
    )
    expect(find('Choose a different season')).equals(undefined)
    expect(text()).includes(TEAM_GAME_NOTE)
    expect(text().indexOf(TEAM_GAME_NOTE)).lessThan(text().lastIndexOf('Save'))
    expect(disabled('Save')).equals(true)
    expect(text()).includes('Details')
    expect(text()).includes('More')
    await press('Save')
    expect(f.sent).length(0)
  })

  it('keeps the source team through a swap and never offers it for the other side', async () => {
    const f = api()
    await open(f)
    await press('Choose Away Team')
    await settle()
    expect(f.anchors.at(-1)).deep.equals({ teamId: team.id })
    expect(find('Choose Demo Hawks')).equals(undefined)
    await press('Choose Demo Owls')
    await press('Swap home and away')
    expect(find('Demo Owls, Home')).not.equals(undefined)
    expect(find('Demo Hawks, Away')).equals(undefined)
    await press('Demo Owls, Home')
    await settle()
    expect(find('Choose Demo Hawks')).equals(undefined)
    await press('Choose Demo Eagles')
    expect(find('Demo Eagles, Home · Placeholder')).not.equals(undefined)
    await press('Save')
    expect(f.sent[0].game).includes({
      homeTeamId: away.id,
      awayTeamId: team.id
    })
    expect(f.sent[0].sender).deep.equals({ kind: 'team', id: team.id })
    expect(f.sent[0].initiatingTeamId).equals(team.id)
  })

  it('sends a team page’s game as an exhibition in no season, and reports what was sent', async () => {
    const f = api()
    await open(f)
    await choose('Away', 'Demo Owls')
    await fill('Outside tournament (optional)', 'Demo Classic')
    await press('Save')
    expect(f.sent[0].game).includes({
      exhibition: true,
      seasonId: null,
      outsideTournament: 'Demo Classic'
    })
    expect(f.saved).deep.equals([
      {
        id: 'request_demo',
        status: 'pending',
        gameId: null,
        proposedGameId: null,
        replacesGameId: null
      }
    ])
  })

  it('lets a season page make a game counting for standings or an exhibition', async () => {
    const f = api(ref => ref.kind === 'season')
    await open(f, { kind: 'season', id: season.id })
    expect(text()).not.includes(TEAM_GAME_NOTE)
    expect(text()).includes('In Demo Spring.')
    expect(
      document.querySelector(
        'input[aria-label="Outside tournament (optional)"]'
      )
    ).equals(null)
    const exhibition = document.querySelector<HTMLInputElement>(
      'input[aria-label="Exhibition"]'
    )!
    expect(exhibition.checked).equals(false)
    await choose('Home', 'Demo Hawks')
    await choose('Away', 'Demo Owls')
    await press('Save')
    await act(async () => {
      exhibition.click()
    })
    await press('Save')
    expect(
      f.sent.map(body => [body.game.seasonId, body.game.exhibition])
    ).deep.equals([
      [season.id, false],
      [season.id, true]
    ])
    expect(f.sent[1].idempotencyKey).not.equals(f.sent[0].idempotencyKey)
  })

  it('creates a staged placeholder once, just before the proposal, and not at all on Cancel', async () => {
    const f = api()
    f.client.proposeGame = async body => {
      f.sent.push(body)
      if (f.sent.length === 1) throw new Error('Offline')
      return proposal('request_placeholder')
    }
    await open(f)
    await press('Choose Away Team')
    await settle()
    await press('Create Placeholder Team')
    expect(text()).includes('Kept by Demo Hawks')
    await fill('Team name', 'Riverside Owls')
    await press('Continue')
    await press('Skip')
    await press('Skip')
    expect(f.created).length(0)
    await press('Save')
    expect(text()).includes('Offline')
    await press('Save')
    expect(f.created).length(1)
    expect(f.created[0].custodian).deep.equals({ kind: 'team', id: team.id })
    expect(f.sent.map(body => body.game.awayTeamId)).deep.equals([
      'team_placeholder',
      'team_placeholder'
    ])
    expect(f.sent[0].idempotencyKey).equals(f.sent[1].idempotencyKey)
    await unmount()
    const g = api()
    await open(g)
    await press('Choose Away Team')
    await settle()
    await press('Create Placeholder Team')
    await fill('Team name', 'Riverside Owls')
    await press('Continue')
    await press('Skip')
    await press('Skip')
    await press('Cancel')
    expect(g.canceled).length(1)
    expect(g.created).length(0)
  })

  it('lets an administered season place a game between two guest teams, either side replaceable', async () => {
    const f = api(ref => ref.kind === 'season')
    await open(f, { kind: 'season', id: season.id })
    expect(find('Choose Home Team')).not.equals(undefined)
    await press('Choose Home Team')
    await settle()
    expect(f.anchors.at(-1)).deep.equals({ seasonId: season.id })
    await press('Choose Demo Hawks')
    await choose('Away', 'Demo Owls')
    expect(f.anchors.at(-1)).deep.equals({
      teamId: team.id,
      seasonId: season.id
    })
    await press('Swap home and away')
    await press('Demo Hawks, Away')
    await settle()
    await press('Choose Demo Eagles')
    await press('Save')
    expect(f.sent[0].sender).deep.equals({ kind: 'season', id: season.id })
    expect(f.sent[0].game).includes({
      seasonId: season.id,
      homeTeamId: third.id,
      awayTeamId: away.id
    })
    expect(f.sent[0].initiatingTeamId).equals(undefined)
    expect(text()).includes(
      'An administrator, coach or assistant of Demo Eagles and Demo Owls must approve'
    )
  })

  it('suggests around the season when the other side is a placeholder not made yet', async () => {
    const f = api()
    await open(f, { kind: 'season', id: season.id })
    await press('Choose Home Team')
    await settle()
    await press('Create Placeholder Team')
    await fill('Team name', 'Riverside Owls')
    await press('Continue')
    await press('Skip')
    await press('Skip')
    await press('Choose Away Team')
    await settle()
    expect(f.anchors.at(-1)).deep.equals({ seasonId: season.id })
  })

  it('keeps title events on the source team after changing a game participant', async () => {
    const f = api()
    let submitted = ''
    f.client.createTeamEvent = async body => {
      submitted = body.teamId
      return { id: 'tev_demo' }
    }
    await open(f)
    await choose('Away', 'Demo Eagles')
    await press('Other')
    expect(
      document.querySelector('[role="heading"], [aria-level]')?.textContent
    ).equals('Create Event')
    // The scene names itself; the form does not repeat it.
    expect(text().split('Create Event').length).equals(2)
    await fill('Title', 'Team dinner')
    await press('Create event')
    expect(submitted).equals(team.id)
    expect(f.events).deep.equals(['tev_demo'])
  })

  it('defaults new games to 45 minutes and Practice/Other to zero without losing the shared draft', async () => {
    await open(api())
    expect(arrival()).equals('45')
    await fill('Venue name (optional)', 'Custom field')
    await fill('Venue address (optional)', '1 Demo Way')
    await fill('Notes (optional)', 'Field 2\nMeet by gate')
    await press('Practice')
    expect(
      document.querySelector('[role="heading"], [aria-level]')?.textContent
    ).equals('Create Practice')
    expect(arrival()).equals('0')
    // A practice is called Practice: it has no title to fill.
    expect(document.querySelector('[aria-label="Title"]')).equals(null)
    await press('Game')
    expect(arrival()).equals('45')
    await press('Other')
    expect(arrival()).equals('0')
    expect(disabled('Create event')).equals(true)
    await fill('Title', 'Team dinner')
    expect(disabled('Create event')).equals(false)
    await press('Game')
    await press('Other')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Title"]')!.value
    ).equals('Team dinner')
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Venue name (optional)"]'
      )!.value
    ).equals('Custom field')
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Notes (optional)"]'
      )!.value
    ).equals('Field 2\nMeet by gate')
    await fill('Arrival minutes (optional)', '10')
    await press('Game')
    expect(arrival()).equals('10')
    await press('Practice')
    expect(arrival()).equals('10')
    await fill('Arrival minutes (optional)', '')
    await press('Game')
    expect(arrival()).equals('')
    await press('Other')
    expect(arrival()).equals('')
  })

  it('saves Practice and optional blank arrival with notes, and validates arrival before publishing', async () => {
    const f = api()
    let sent: unknown
    f.client.createTeamEvent = async body => {
      sent = body
      return { id: 'tev_demo' }
    }
    await open(f)
    await press('Practice')
    await fill('Notes (optional)', 'Field 2')
    await fill('Arrival minutes (optional)', '0.5')
    await press('Create event')
    expect(sent).equals(undefined)
    expect(text()).includes('whole minutes')
    await fill('Arrival minutes (optional)', '')
    await press('Create event')
    expect(sent).includes({
      eventType: 'practice',
      title: '',
      arrivalTimeDelta: null,
      notes: 'Field 2'
    })
  })

  it('keeps an identical event retry after switching through Game', async () => {
    const f = api()
    const sent: Array<Parameters<TeamStationClient['createTeamEvent']>[0]> = []
    f.client.createTeamEvent = async body => {
      sent.push(body)
      if (sent.length === 1) throw new Error('Synthetic lost response')
      return { id: 'tev_retry' }
    }
    await open(f)
    await press('Practice')
    await press('Create event')
    expect(text()).includes('Synthetic lost response')
    await press('Game')
    await press('Practice')
    await press('Create event')
    expect(sent).length(2)
    expect(sent[1]).deep.equals(sent[0])
    expect(f.events).deep.equals(['tev_retry'])
  })

  it('locks the outer event type and title until a titled save completes', async () => {
    const f = api()
    let complete: ((result: { id: string }) => void) | undefined
    f.client.createTeamEvent = async () =>
      await new Promise(resolve => {
        complete = resolve
      })
    await open(f)
    await press('Other')
    await fill('Title', 'Demo dinner')
    await press('Create event')
    for (const index of [0, 1, 2])
      expect(
        document
          .querySelector(`[data-testid="event-type-${index}"]`)
          ?.getAttribute('aria-disabled')
      ).equals('true')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Title"]')?.readOnly
    ).equals(true)
    await press('Game')
    await press('Back')
    expect(text()).includes('Create Event')
    expect(f.canceled).length(0)
    await act(async () => {
      complete!({ id: 'tev_busy' })
    })
    expect(f.events).deep.equals(['tev_busy'])
    expect(
      document
        .querySelector('[data-testid="event-type-0"]')
        ?.getAttribute('aria-disabled')
    ).not.equals('true')
  })

  it('uses the canonical source team returned for a merged team address', async () => {
    const f = api()
    const group = f.client.group.bind(f.client)
    f.client.group = async ref => {
      const detail = await group(ref)
      return ref.id === team.id
        ? { ...detail, group: { ...detail.group, id: 'team_kept' } }
        : detail
    }
    let submitted = ''
    f.client.createTeamEvent = async body => {
      submitted = body.teamId
      return { id: 'tev_demo' }
    }
    await open(f)
    // The team the address became is the one that must stay.
    expect(find('Demo Hawks, Home')).equals(undefined)
    await choose('Away', 'Demo Owls')
    await press('Save')
    expect(f.sent[0].sender).deep.equals({ kind: 'team', id: 'team_kept' })
    expect(f.sent[0].initiatingTeamId).equals('team_kept')
    await press('Other')
    await fill('Title', 'Team dinner')
    await press('Create event')
    expect(submitted).equals('team_kept')
  })

  it('keeps placeholder teams in game mode even when their details are manageable', async () => {
    await open(api(), { kind: 'team', id: away.id })
    const event = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="button"], [role="radio"]'
      )
    ].find(node => node.textContent === 'Other')!
    expect(event.getAttribute('aria-disabled')).equals('true')
    await press('Other')
    expect(document.querySelector('input[aria-label="Title"]')).equals(null)
    expect(text()).includes('Create Game')
  })

  it('rechecks the season’s authority before submitting and keeps the draft on refusal', async () => {
    let seasonAdmin = true
    const f = api(ref => ref.kind !== 'season' || seasonAdmin)
    await open(f, { kind: 'season', id: season.id })
    await choose('Home', 'Demo Hawks')
    await choose('Away', 'Demo Eagles')
    seasonAdmin = false
    await press('Save')
    expect(f.sent).length(0)
    expect(text()).includes(
      'You need administrator access to host this game in that season.'
    )
    expect(find('Demo Eagles, Away · Placeholder')).not.equals(undefined)
  })

  it('warns of a date outside the season’s time frame until dismissed', async () => {
    const f = api()
    await open(f, { kind: 'season', id: season.id })
    await fill('Date', '2029-07-01')
    expect(text()).includes('outside the season’s reference')
    await press('Dismiss date warning')
    expect(text()).not.includes('outside the season’s reference')
    expect(
      document.querySelector('[data-testid="event-schedule-date"]')!.textContent
    ).includes('2029-07-01')
    await fill('Date', '2029-07-02')
    expect(text()).includes('outside the season’s reference')
  })

  it('keeps game choices and retry identity after a sending failure; changes retry identity with material terms', async () => {
    const f = api()
    const keys: string[] = []
    const origins: Array<string | null | undefined> = []
    const dates: string[] = []
    f.client.proposeGame = async body => {
      keys.push(body.idempotencyKey)
      origins.push(body.initiatingTeamId)
      dates.push(body.game.startAt)
      throw new Error('Sending offline')
    }
    await open(f)
    await choose('Away', 'Demo Eagles')
    await fill('Date', '2029-07-01')
    await fill('Time', '18:00')
    await fill('Time zone', 'UTC')
    await fill('Outside tournament (optional)', 'Demo Classic')
    await press('Save')
    expect(text()).includes('Sending offline')
    await press('Save')
    expect(keys[0]).equals(keys[1])
    await fill('Date', '2029-07-02')
    await press('Save')
    expect(keys[2]).not.equals(keys[1])
    expect(origins[2]).equals(team.id)
    expect(dates[2]).equals('2029-07-02T18:00:00.000Z')
    f.client.proposeGame = async body => {
      f.sent.push(body)
      return proposal('request_demo', 'accepted')
    }
    await press('Save')
    expect(f.sent[0].game).includes({
      seasonId: null,
      exhibition: true,
      outsideTournament: 'Demo Classic'
    })
    expect(f.saved.map(saved => saved.status)).deep.equals(['accepted'])
    await press('Cancel')
    expect(f.canceled).length(1)
  })

  it('works without the managing groups, and rejects invalid wall times without sending', async () => {
    const f = api()
    f.client.ownGroups = async () => {
      throw new Error('offline')
    }
    await open(f)
    await choose('Away', 'Demo Eagles')
    await fill('Time zone', 'America/Los_Angeles')
    await fill('Date', '2027-03-14')
    await fill('Time', '02:30')
    await press('Save')
    expect(text()).includes('does not exist')
    expect(f.sent).length(0)
  })

  it('makes a failed source load retryable', async () => {
    const f = api()
    const group = f.client.group.bind(f.client)
    let fail = true
    f.client.group = async ref => {
      if (fail) throw new Error('Team unavailable')
      return await group(ref)
    }
    await open(f)
    expect(text()).includes('Team unavailable')
    fail = false
    await press('Retry game')
    await settle()
    expect(find('Choose Away Team')).not.equals(undefined)
    await press('Cancel')
    expect(f.canceled).length(1)
  })

  it('asks once who may keep a placeholder, however often the teams change', async () => {
    const f = api()
    let asked = 0
    f.client.ownGroups = async () => {
      asked++
      return [season, team]
    }
    await open(f)
    await choose('Away', 'Demo Owls')
    await press('Swap home and away')
    await press('Demo Owls, Home')
    await settle()
    await press('Choose Demo Eagles')
    await press('Swap home and away')
    expect(asked).equals(1)
  })

  it('refuses a game from a team its viewer does not manage', async () => {
    const f = api(() => false)
    await open(f)
    expect(text()).includes(
      'You need administrator access to create a game here.'
    )
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Outside tournament (optional)"]'
      )?.readOnly
    ).equals(true)
    expect(find('Choose Away Team')).equals(undefined)
    expect(disabled('Save')).equals(true)
  })

  it('orders placeholder keepers from the game it is made for', async () => {
    const f = api()
    const own: PublicGroup[] = [season, third, team]
    f.client.ownGroups = async () => own
    await open(f)
    await press('Choose Away Team')
    await settle()
    await press('Create Placeholder Team')
    expect(text()).includes('Kept by Demo Hawks')
  })
})
