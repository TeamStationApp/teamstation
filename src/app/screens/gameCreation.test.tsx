import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asGameIntent } from '../../common/gameApprovals'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { chooseSchedule } from '../../test/eventScheduleDom'
import { ThemeProvider } from '../theme/ThemeContext'
import { CreateGameScreen } from './CreateGameScreen'
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
async function fill(label: string, value: string): Promise<void> {
  if (
    [
      'Date',
      'End date',
      'Time',
      'Start time',
      'End time',
      'Time zone'
    ].includes(label)
  ) {
    await chooseSchedule(label, value)
    return
  }
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
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
    administeredTeamIds: [team.id]
  })
  client.gameProposals = async () => []
  return client
}
describe('game scheduling interface recovery', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
  })
  it('adds an end time to a future game on its loaded local start date', async () => {
    const client = api()
    client.gameScheduling = async () => ({
      game: {
        ...game,
        startAt: '2037-07-02T02:00:00.000Z',
        timezone: 'America/Los_Angeles'
      },
      version: 'a'.repeat(64),
      canPropose: true,
      withdrawTeamIds: [team.id],
      administeredTeamIds: [team.id]
    })
    let sent: Parameters<TeamStationClient['proposeGame']>[0] | undefined
    client.proposeGame = async body => {
      sent = body
      return {
        id: 'request_end',
        status: 'pending',
        gameId: null,
        proposedGameId: null,
        replacesGameId: null
      }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        gameId="game_demo"
        onSent={() => undefined}
        onCancel={() => undefined}
      />
    )
    await press('Set end time')
    expect(
      document.querySelector('[data-testid="event-schedule-endTime"]')
    ).not.equals(null)
    await press('Send game proposal')
    expect(sent?.game.startAt).equals('2037-07-02T02:00:00.000Z')
    expect(sent?.game.endAt).equals('2037-07-02T05:00:00.000Z')
  })
  it('keeps title events on the source team after changing a game participant', async () => {
    const client = api()
    let submitted = ''
    client.createTeamEvent = async body => {
      submitted = body.teamId
      return { id: 'tev_demo' }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => undefined}
        onEventCreated={() => undefined}
        onCancel={() => undefined}
      />
    )
    await press('Home: Demo Hawks')
    await press('Choose Demo Eagles')
    await press('Other')
    await fill('Title', 'Team dinner')
    await press('Create event')
    expect(submitted).equals(team.id)
  })
  it('defaults new games to 45 minutes and Practice/Other to zero without losing the shared draft', async () => {
    await mount(
      <CreateGameScreen
        client={api()}
        source={{ kind: 'team', id: team.id }}
        onSent={() => undefined}
        onCancel={() => undefined}
      />
    )
    const arrival = (): string =>
      document.querySelector<HTMLInputElement>(
        '[aria-label="Arrival minutes (optional)"]'
      )!.value
    expect(arrival()).equals('45')
    await fill('Venue name (optional)', 'Custom field')
    await fill('Venue address (optional)', '1 Demo Way')
    await fill('Notes (optional)', 'Field 2\nMeet by gate')
    await press('Practice')
    expect(arrival()).equals('0')
    await fill('Title', 'Demo practice')
    await press('Game')
    expect(arrival()).equals('45')
    await press('Other')
    expect(arrival()).equals('0')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Title"]')!.value
    ).equals('Demo practice')
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
    const client = api()
    let sent: unknown
    client.createTeamEvent = async body => {
      sent = body
      return { id: 'tev_demo' }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => undefined}
        onCancel={() => undefined}
      />
    )
    await press('Practice')
    await fill('Title', 'Demo practice')
    await fill('Notes (optional)', 'Field 2')
    await fill('Arrival minutes (optional)', '0.5')
    await press('Create event')
    expect(sent).equals(undefined)
    expect(document.body.textContent).includes('whole minutes')
    await fill('Arrival minutes (optional)', '')
    await press('Create event')
    expect(sent).includes({
      eventType: 'practice',
      arrivalTimeDelta: null,
      notes: 'Field 2'
    })
  })
  it('keeps an identical event retry after switching through Game', async () => {
    const client = api()
    const sent: Array<Parameters<TeamStationClient['createTeamEvent']>[0]> = []
    client.createTeamEvent = async body => {
      sent.push(body)
      if (sent.length === 1) throw new Error('Synthetic lost response')
      return { id: 'tev_retry' }
    }
    const saved: string[] = []
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={id => saved.push(id)}
        onCancel={() => undefined}
      />
    )
    await press('Practice')
    await fill('Title', 'Demo practice')
    await press('Create event')
    expect(document.body.textContent).includes('Synthetic lost response')
    await press('Game')
    await press('Practice')
    await press('Create event')
    expect(sent).length(2)
    expect(sent[1]).deep.equals(sent[0])
    expect(saved).deep.equals(['tev_retry'])
  })
  it('locks the outer event type and title until a titled save completes', async () => {
    const client = api()
    let complete: ((result: { id: string }) => void) | undefined
    client.createTeamEvent = async () =>
      await new Promise(resolve => {
        complete = resolve
      })
    let canceled = false
    const saved: string[] = []
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={id => saved.push(id)}
        onCancel={() => {
          canceled = true
        }}
      />
    )
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
    expect(document.body.textContent).includes('Create Event')
    expect(canceled).equals(false)
    await act(async () => {
      complete!({ id: 'tev_busy' })
    })
    expect(saved).deep.equals(['tev_busy'])
    expect(
      document
        .querySelector('[data-testid="event-type-0"]')
        ?.getAttribute('aria-disabled')
    ).not.equals('true')
  })
  it('uses the canonical source team returned for a merged team address', async () => {
    const client = api()
    const group = client.group.bind(client)
    client.group = async ref => {
      const detail = await group(ref)
      return ref.id === team.id
        ? { ...detail, group: { ...detail.group, id: 'team_kept' } }
        : detail
    }
    let submitted = ''
    client.createTeamEvent = async body => {
      submitted = body.teamId
      return { id: 'tev_demo' }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => undefined}
        onCancel={() => undefined}
      />
    )
    await press('Home: Demo Hawks')
    await press('Choose Demo Eagles')
    await press('Other')
    await fill('Title', 'Team dinner')
    await press('Create event')
    expect(submitted).equals('team_kept')
  })
  it('keeps placeholder teams in game mode even when their details are manageable', async () => {
    await mount(
      <CreateGameScreen
        client={api()}
        source={{ kind: 'team', id: away.id }}
        onSent={() => undefined}
        onCancel={() => undefined}
      />
    )
    const event = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="button"], [role="radio"]'
      )
    ].find(node => node.textContent === 'Other')!
    expect(event.getAttribute('aria-disabled')).equals('true')
    await press('Other')
    expect(document.querySelector('input[aria-label="Title"]')).equals(null)
    expect(document.body.textContent).includes('Create Game')
  })
  it('lets an administered season originate a placement between two guest teams without claiming their approval', async () => {
    const client = api()
    const group = client.group.bind(client)
    client.group = async ref =>
      asGroupDetail({ ...(await group(ref)), canManage: ref.kind === 'season' })
    let sent: Parameters<TeamStationClient['proposeGame']>[0] | undefined
    let result = ''
    client.proposeGame = async body => {
      sent = body
      return {
        id: 'request_guests',
        status: 'pending',
        gameId: null,
        proposedGameId: 'gam_guests',
        replacesGameId: null
      }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'season', id: season.id }}
        onSent={id => {
          result = id
        }}
        onCancel={() => {}}
      />
    )
    await press('Home: Choose team')
    await press('Choose Demo Hawks')
    await press('Away: Choose team')
    await press('Choose Demo Eagles')
    await press('Send game proposal')
    expect(sent?.sender).deep.equals({ kind: 'season', id: season.id })
    expect(sent?.game).includes({
      seasonId: season.id,
      homeTeamId: team.id,
      awayTeamId: away.id
    })
    expect(sent?.initiatingTeamId).equals(undefined)
    expect(result).equals('request_guests')
  })
  it('does not offer owned or discovered seasons without host administration and keeps the game outside a season', async () => {
    const client = api()
    const foreign = asPublicGroup({
      ...season,
      id: 'season_foreign',
      name: 'Demo Foreign Season'
    })
    client.discoverGroups = async kind =>
      kind === 'season' ? [foreign] : [team, away]
    const group = client.group.bind(client)
    client.group = async ref =>
      ref.kind === 'season'
        ? asGroupDetail({
            nonMemberView: false,
            group: ref.id === foreign.id ? foreign : season,
            parents: [],
            children: [],
            competingTeams: [],
            participatingSeasons: [],
            staff: [],
            games: [],
            canManage: false
          })
        : await group(ref)
    const sent: Array<Parameters<TeamStationClient['proposeGame']>[0]> = []
    client.proposeGame = async body => {
      sent.push(body)
      return {
        id: 'request_outside',
        status: 'pending',
        gameId: null,
        proposedGameId: 'gam_outside',
        replacesGameId: null
      }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Eagles')
    await press('Choose a different season')
    await fill('Find a season you manage', 'Demo Foreign')
    await settle()
    expect(document.body.textContent).not.includes('Host: Demo Foreign Season')
    expect(document.body.textContent).not.includes('Host: Demo Spring')
    expect(sent).length(0)
    await press('Outside a TeamStation season')
    await press('Send game proposal')
    expect(sent).length(1)
    expect(sent[0].sender).deep.equals({ kind: 'team', id: team.id })
    expect(sent[0].game.seasonId).equals(null)
  })
  it('offers only administered discovered hosts and preserves the team sender for an owned hosted placement', async () => {
    const client = api()
    const foreign = asPublicGroup({
      ...season,
      id: 'season_foreign',
      name: 'Demo Foreign Season'
    })
    client.ownGroups = async () => []
    client.discoverGroups = async kind =>
      kind === 'season' ? [foreign, season] : [team, away]
    const group = client.group.bind(client)
    client.group = async ref =>
      ref.id === foreign.id
        ? asGroupDetail({
            nonMemberView: false,
            group: foreign,
            parents: [],
            children: [],
            competingTeams: [],
            participatingSeasons: [],
            staff: [],
            games: [],
            canManage: false
          })
        : await group(ref)
    let sent: Parameters<TeamStationClient['proposeGame']>[0] | undefined
    client.proposeGame = async body => {
      sent = body
      return {
        id: 'request_owned',
        status: 'pending',
        gameId: null,
        proposedGameId: 'gam_owned',
        replacesGameId: null
      }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Eagles')
    await press('Choose a different season')
    await settle()
    expect(document.body.textContent).not.includes('Host: Demo Foreign Season')
    await press('Host: Demo Spring')
    await press('Send game proposal')
    expect(sent?.sender).deep.equals({ kind: 'team', id: team.id })
    expect(sent?.game.seasonId).equals(season.id)
  })
  it('rechecks selected host authority before submitting and retains local choices on refusal', async () => {
    const client = api()
    let hostAdmin = true
    const group = client.group.bind(client)
    client.group = async ref =>
      ref.kind === 'season'
        ? asGroupDetail({ ...(await group(ref)), canManage: hostAdmin })
        : await group(ref)
    let submitted = 0
    client.proposeGame = async () => {
      submitted++
      return {
        id: 'request_wrong',
        status: 'pending',
        gameId: null,
        proposedGameId: null,
        replacesGameId: null
      }
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    await press('Choose Demo Eagles')
    await press('Choose a different season')
    await press('Host: Demo Spring')
    hostAdmin = false
    await press('Send game proposal')
    expect(submitted).equals(0)
    expect(document.body.textContent).includes(
      'You need administrator access to host this game in that season.'
    )
    expect(document.body.textContent).includes('Hosted by Demo Spring')
  })
  it('waits for saved revision details before allowing edits and leaves load failures retryable', async () => {
    const client = api()
    let resolveGame!: (
      value: Awaited<ReturnType<TeamStationClient['gameScheduling']>>
    ) => void
    client.gameScheduling = async () =>
      await new Promise(resolve => {
        resolveGame = resolve
      })
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        gameId="game_demo"
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    expect(document.body.textContent).includes('Loading game')
    expect(
      document.querySelector('input[aria-label="Venue name (optional)"]')
    ).equals(null)
    await act(async () => {
      resolveGame({
        game: { ...game, venue: 'Saved Field' },
        version: 'a'.repeat(64),
        canPropose: true,
        withdrawTeamIds: [team.id],
        administeredTeamIds: [team.id]
      })
    })
    await settle()
    await fill('Venue name (optional)', 'Edited Field')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Venue name (optional)"]'
      )!.value
    ).equals('Edited Field')
    client.group = async () => {
      throw new Error('Game unavailable')
    }
    await press('Retry teams')
    await settle()
    expect(document.body.textContent, document.body.textContent ?? '').includes(
      'Game unavailable'
    )
  })
  it('keeps game choices and retry identity after a sending failure; changes retry identity with material terms', async () => {
    const client = api()
    const keys: string[] = []
    const origins: Array<string | null | undefined> = []
    const dates: string[] = []
    let sent = ''
    let cancelled = false
    client.proposeGame = async body => {
      keys.push(body.idempotencyKey)
      origins.push(body.initiatingTeamId)
      dates.push(body.game.startAt)
      throw new Error('Sending offline')
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={id => {
          sent = id
        }}
        onCancel={() => {
          cancelled = true
        }}
      />
    )
    await press('Choose Demo Eagles')
    await fill('Date', '2029-07-01')
    await fill('Time', '18:00')
    await fill('Time zone', 'UTC')
    await fill('Outside tournament (optional)', 'Demo Classic')
    await press('Send game proposal')
    expect(document.body.textContent).includes('Sending offline')
    await press('Send game proposal')
    expect(keys[0]).equals(keys[1])
    await press('Choose a different season')
    await press('Host: Demo Spring')
    expect(document.body.textContent).includes('outside the season’s reference')
    await press('Dismiss date warning')
    expect(document.body.textContent).not.includes(
      'outside the season’s reference'
    )
    expect(
      document.querySelector('[data-testid="event-schedule-date"]')!.textContent
    ).includes('2029-07-01')
    await press('Send game proposal')
    expect(keys[2]).not.equals(keys[1])
    expect(origins[2]).equals(team.id)
    expect(dates[2]).equals('2029-07-01T18:00:00.000Z')
    await fill('Date', '2029-07-02')
    expect(document.body.textContent).includes('outside the season’s reference')
    client.proposeGame = async () => ({
      id: 'request_demo',
      status: 'pending',
      gameId: null,
      proposedGameId: null,
      replacesGameId: null
    })
    await press('Choose a different season')
    await press('Outside a TeamStation season')
    await press('Send game proposal')
    expect(sent).equals('request_demo')
    await press('Home: Demo Hawks')
    await press('Choose Demo Eagles')
    await press('Retry teams')
    await settle()
    await press('Cancel')
    expect(cancelled).equals(true)
  })
  it('loads revisions, exposes cancellation and fails safely when scheduling authority is absent', async () => {
    const client = api()
    client.gameScheduling = async () => ({
      game: { ...game, seasonId: season.id, venue: 'Demo Field' },
      version: 'a'.repeat(64),
      canPropose: false,
      withdrawTeamIds: [],
      administeredTeamIds: []
    })
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'season', id: season.id }}
        gameId="game_demo"
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    expect(document.body.textContent).includes('cannot be changed here')
    await press('Propose cancellation')
    await press('Cancellation selected')
  })
  it('shows lookup errors, retries and rejects invalid wall times without sending', async () => {
    const client = api()
    client.ownGroups = async () => {
      throw new Error('offline')
    }
    client.discoverGroups = async () => {
      throw new Error('offline')
    }
    await mount(
      <CreateGameScreen
        client={client}
        source={{ kind: 'team', id: team.id }}
        onSent={() => {}}
        onCancel={() => {}}
      />
    )
    expect(document.body.textContent).includes('could not load')
    client.discoverGroups = async () => [away]
    await press('Retry teams')
    await settle()
    await press('Choose Demo Eagles')
    await fill('Time zone', 'America/Los_Angeles')
    await fill('Date', '2027-03-14')
    await fill('Time', '02:30')
    await press('Send game proposal')
    expect(document.body.textContent).includes('does not exist')
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
