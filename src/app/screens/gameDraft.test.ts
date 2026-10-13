import { expect } from 'chai'
import { describe, it } from 'mocha'

import { newEventSchedule } from '../../common/eventSchedule'
import { asGameIntent } from '../../common/gameApprovals'
import { asPublicGroup, type PublicGroup } from '../../common/publicGroups'
import {
  choosesExhibition,
  chooseTeam,
  draftProblem,
  type GameDraft,
  type GameFormMode,
  gameProposalFields,
  type LoadedGame,
  loadedGameDraft,
  newGameDraft,
  otherSide,
  replaceableSides,
  selectorAnchor,
  sourceTeamId,
  swapSides,
  TEAM_GAME_NOTE
} from './gameDraft'
import type { TeamChoice } from './PlaceholderTeamForm'

const group = (id: string, kind: 'team' | 'season' = 'team'): PublicGroup =>
  asPublicGroup({
    id,
    kind,
    name: `Demo ${id}`,
    imageUrl: null,
    locality: null
  })
const choice = (id: string, canManage = true): TeamChoice => ({
  group: group(id),
  canManage
})
const hawks = choice('hawks')
const eagles = choice('eagles')
const owls = choice('owls')
const staged: TeamChoice = {
  ...choice('draft-key'),
  placeholder: {
    kind: 'team',
    name: 'Riverside Owls',
    external: true,
    custodian: { kind: 'team', id: 'hawks' },
    idempotencyKey: 'placeholder-key'
  }
}
const season = group('spring', 'season')
const fromTeam: Extract<GameFormMode, { kind: 'create' }> = {
  kind: 'create',
  source: { kind: 'team', id: 'hawks' }
}
const fromSeason: Extract<GameFormMode, { kind: 'create' }> = {
  kind: 'create',
  source: { kind: 'season', id: 'spring' }
}
const editing: GameFormMode = { kind: 'edit', gameId: 'game_demo' }
const loaded: LoadedGame = {
  game: asGameIntent({
    homeTeamId: 'hawks',
    awayTeamId: 'eagles',
    seasonId: 'spring',
    startAt: '2027-04-10T18:00:00.000Z',
    endAt: '2027-04-10T20:00:00.000Z',
    venue: 'Demo Field',
    address: '1 Demo Way',
    notes: 'Gate B',
    arrivalTimeDelta: 30,
    outsideTournament: null,
    exhibition: true,
    timezone: 'UTC',
    status: 'scheduled'
  }),
  version: 'a'.repeat(64),
  withdrawTeamIds: ['hawks'],
  canPropose: true
}
const ready = (draft: GameDraft): GameDraft => ({
  ...draft,
  schedule: newEventSchedule('2027-04-10T18:00:00.000Z', null, 'UTC', 'UTC')
})

describe('game draft rules', () => {
  it('starts a team game at home as an exhibition, and a season game in its season', () => {
    const team = newGameDraft(fromTeam, hawks)
    expect(team.home).equals(hawks)
    expect(team.away).equals(undefined)
    expect(team.season).equals(undefined)
    expect(team).includes({ arrival: '45', exhibition: true })
    const hosted = newGameDraft(fromSeason, { group: season, canManage: true })
    expect(hosted.home).equals(undefined)
    expect(hosted.season).equals(season)
    expect(hosted.exhibition).equals(false)
    expect(choosesExhibition(fromTeam)).equals(false)
    expect(choosesExhibition(fromSeason)).equals(true)
    expect(choosesExhibition(editing, loaded)).equals(true)
    expect(
      choosesExhibition(editing, {
        ...loaded,
        game: { ...loaded.game, seasonId: null }
      })
    ).equals(false)
    expect(choosesExhibition(editing)).equals(false)
    expect(TEAM_GAME_NOTE).equals(
      'Creating a game from within the team interface always creates a scrimmage/exhibition game. To create a game that counts for season standings within a season, create the game from the season interface.'
    )
    expect(sourceTeamId(fromTeam)).equals('hawks')
    expect(sourceTeamId(fromSeason)).equals(undefined)
    expect(sourceTeamId(editing)).equals(undefined)
    expect(otherSide('home')).equals('away')
    expect(otherSide('away')).equals('home')
  })

  it('loads a saved game into a draft', () => {
    const draft = loadedGameDraft(loaded, hawks, eagles)
    expect(draft).includes({
      venue: 'Demo Field',
      address: '1 Demo Way',
      notes: 'Gate B',
      arrival: '30',
      exhibition: true,
      outsideTournament: ''
    })
    const bare = loadedGameDraft(
      {
        ...loaded,
        game: asGameIntent({
          homeTeamId: 'hawks',
          awayTeamId: 'eagles',
          seasonId: null,
          startAt: '2027-04-10T18:00:00.000Z',
          venue: null,
          outsideTournament: 'Demo Classic',
          status: 'scheduled'
        })
      },
      hawks,
      eagles
    )
    expect(bare).includes({
      venue: '',
      address: '',
      notes: '',
      arrival: '',
      exhibition: false,
      outsideTournament: 'Demo Classic'
    })
  })

  it('keeps the source team’s side fixed, wherever a swap puts it', () => {
    const draft = { ...newGameDraft(fromTeam, hawks), away: eagles }
    expect(replaceableSides(draft, fromTeam)).deep.equals(['away'])
    const swapped = swapSides(draft)
    expect(swapped.home).equals(eagles)
    expect(swapped.away).equals(hawks)
    expect(replaceableSides(swapped, fromTeam)).deep.equals(['home'])
    expect(
      replaceableSides(
        newGameDraft(fromSeason, { group: season, canManage: true }),
        fromSeason
      )
    ).deep.equals(['home', 'away'])
    expect(replaceableSides(draft, editing, loaded)).deep.equals([
      'home',
      'away'
    ])
    expect(
      replaceableSides(draft, editing, { ...loaded, canPropose: false })
    ).deep.equals([])
    expect(replaceableSides(draft, editing)).deep.equals([])
  })

  it('refuses the same team on both sides, and replacing the source team', () => {
    const draft = newGameDraft(fromTeam, hawks)
    expect(chooseTeam(draft, 'away', owls, fromTeam).away).equals(owls)
    expect(() => chooseTeam(draft, 'away', hawks, fromTeam)).throws(
      'Choose two different teams.'
    )
    expect(() => chooseTeam(draft, 'home', owls, fromTeam)).throws(
      'Demo hawks must play in this game.'
    )
    expect(
      chooseTeam({ ...draft, away: eagles }, 'home', owls, editing).home
    ).equals(owls)
  })

  it('names the first thing stopping Save', () => {
    const empty = newGameDraft(fromSeason, { group: season, canManage: true })
    expect(draftProblem(empty, fromSeason)).equals('Choose the home team')
    expect(draftProblem({ ...empty, home: hawks }, fromSeason)).equals(
      'Choose the away team'
    )
    expect(
      draftProblem({ ...empty, home: hawks, away: choice('hawks') }, fromSeason)
    ).equals('Choose two different teams')
    expect(
      draftProblem(
        { ...empty, home: owls, away: eagles },
        fromTeam,
        'Demo Hawks'
      )
    ).equals('Demo Hawks must play in this game')
    expect(
      draftProblem({ ...empty, home: owls, away: eagles }, fromTeam)
    ).equals('The team this game was created from must play in this game')
    expect(
      draftProblem({ ...empty, home: owls, away: hawks }, fromTeam)
    ).equals(undefined)
  })

  it('suggests around saved teams and the season, never a placeholder not made yet', () => {
    const team = newGameDraft(fromTeam, hawks)
    expect(selectorAnchor(team, 'away', fromTeam, undefined)).deep.equals({
      teamId: 'hawks'
    })
    const hosted = newGameDraft(fromSeason, { group: season, canManage: true })
    expect(selectorAnchor(hosted, 'home', fromSeason, 'spring')).deep.equals({
      seasonId: 'spring'
    })
    expect(
      selectorAnchor({ ...hosted, home: hawks }, 'away', fromSeason, 'spring')
    ).deep.equals({ teamId: 'hawks', seasonId: 'spring' })
    expect(
      selectorAnchor({ ...hosted, home: staged }, 'away', fromSeason, 'spring')
    ).deep.equals({ seasonId: 'spring' })
    expect(
      selectorAnchor({ ...hosted, home: staged }, 'away', fromSeason, null)
    ).deep.equals({})
    const edit = loadedGameDraft(loaded, hawks, eagles)
    expect(selectorAnchor(edit, 'away', editing, 'spring')).deep.equals({
      teamId: 'hawks',
      seasonId: 'spring'
    })
    expect(
      selectorAnchor({ ...edit, home: staged }, 'away', editing, null)
    ).deep.equals({ teamId: 'eagles' })
    expect(
      selectorAnchor(
        { ...edit, home: staged, away: staged },
        'away',
        editing,
        null
      )
    ).deep.equals({})
  })

  it('proposes a team page’s game as its team, always an exhibition in no season', () => {
    const draft = ready({
      ...newGameDraft(fromTeam, hawks),
      away: eagles,
      venue: ' North Field ',
      address: ' ',
      notes: ' Gate B ',
      arrival: '45',
      outsideTournament: ' Demo Classic ',
      exhibition: false
    })
    const outside = gameProposalFields(draft, fromTeam, hawks, eagles)
    expect(outside.sender).deep.equals({ kind: 'team', id: 'hawks' })
    expect(outside.initiatingTeamId).equals('hawks')
    expect(outside.game).deep.include({
      homeTeamId: 'hawks',
      awayTeamId: 'eagles',
      seasonId: null,
      venue: 'North Field',
      notes: 'Gate B',
      arrivalTimeDelta: 45,
      exhibition: true,
      outsideTournament: 'Demo Classic',
      startAt: '2027-04-10T18:00:00.000Z',
      status: 'scheduled'
    })
    expect(outside.game).not.have.property('address')
    // Even a draft carrying a season is never placed in it from a team page.
    const seasoned = gameProposalFields(
      { ...draft, season, address: '1 Demo Way' },
      fromTeam,
      owls,
      eagles
    )
    expect(seasoned.sender).deep.equals({ kind: 'team', id: 'hawks' })
    expect(seasoned).not.have.property('initiatingTeamId')
    expect(seasoned.game).deep.include({
      seasonId: null,
      exhibition: true,
      address: '1 Demo Way'
    })
  })

  it('proposes a season page’s game as the season, in the season, counting or exhibition', () => {
    const draft = ready({
      ...newGameDraft(fromSeason, { group: season, canManage: true }),
      home: hawks,
      away: eagles,
      venue: '',
      notes: '',
      arrival: ''
    })
    const hosted = gameProposalFields(draft, fromSeason, hawks, eagles)
    expect(hosted.sender).deep.equals({ kind: 'season', id: 'spring' })
    expect(hosted).not.have.property('initiatingTeamId')
    expect(hosted.game).deep.include({
      seasonId: 'spring',
      exhibition: false,
      outsideTournament: null,
      venue: null,
      notes: null,
      arrivalTimeDelta: null
    })
    expect(
      gameProposalFields(
        { ...draft, exhibition: true, outsideTournament: 'Demo Classic' },
        fromSeason,
        hawks,
        eagles
      ).game
    ).deep.include({
      seasonId: 'spring',
      exhibition: true,
      outsideTournament: null
    })
  })

  it('proposes a change as the first team the person may withdraw, clearing a moved address', () => {
    const draft = ready(loadedGameDraft(loaded, hawks, eagles))
    const same = gameProposalFields(draft, editing, eagles, hawks, loaded)
    expect(same).deep.include({
      sender: { kind: 'team', id: 'hawks' },
      initiatingTeamId: 'hawks',
      gameId: 'game_demo',
      expected: 'a'.repeat(64)
    })
    expect(same.game).deep.include({
      homeTeamId: 'eagles',
      awayTeamId: 'hawks',
      address: '1 Demo Way',
      seasonId: 'spring',
      exhibition: true
    })
    expect(same.game).not.have.property('latitude')
    const moved = gameProposalFields(
      { ...draft, address: '2 Demo Way' },
      editing,
      hawks,
      eagles,
      loaded
    )
    expect(moved.game).deep.include({
      address: '2 Demo Way',
      latitude: null,
      longitude: null
    })
    expect(() =>
      gameProposalFields(draft, editing, hawks, eagles, {
        ...loaded,
        withdrawTeamIds: []
      })
    ).throws('You need administrator access to a participating team.')
    expect(() => gameProposalFields(draft, editing, hawks, eagles)).throws(
      'Game settings could not load.'
    )
  })
})
