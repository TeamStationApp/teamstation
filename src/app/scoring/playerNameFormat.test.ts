import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { namesOf } from '../../common/replay/replayNames'
import {
  drawnName,
  keyterms,
  modelNameOf,
  promptContext,
  shortName
} from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import {
  resolveRosterCommands,
  rosterPrompt,
  rosterSituation
} from '../../common/scoring/rosterCommands'
import {
  applyAction,
  type EventStore,
  ScoringSession,
  upcoming
} from '../../common/scoring/session'
import {
  asGameState,
  copyState,
  type GameState
} from '../../common/scoring/state'
import { withoutNames } from '../../common/scoring/storedNames'
import { userIdOfGumbo } from '../../common/userId'
import { game } from '../../test/scoringGames'
import { appliedEvents } from '../sync/optimistic'
import { shortPlayerNames, withRosterDetails } from './currentSetup'
import { playerPatterns } from './dictatedCompletion'
import { describePlay } from './playDescription'
import { addRosteredPlayer } from './playerDraft'
import { scoreboardFor } from './scoringSelectors'

const batterOf = (state: GameState): number =>
  state.liveData.linescore.offense.batter!.id

/** A game whose batter is `Alex Lee`, labelled and held as the reader would. */
function labelled(
  fullName: string,
  extra: { nameFormat?: 'initials' | 'initialLast' | 'full'; halves?: boolean }
): GameState {
  const state = copyState(game())
  const id = batterOf(state)
  state.gameData.players[id] = {
    ...state.gameData.players[id],
    fullName,
    ...(extra.nameFormat == null ? {} : { nameFormat: extra.nameFormat }),
    ...(extra.halves === true ? { firstName: 'Alex', lastName: 'Lee' } : {})
  }
  state.liveData.linescore.offense.batter = { id, fullName }
  return state
}

const withModelNames = (state: GameState): GameState => ({
  ...state,
  meta: {
    ...state.meta,
    modelNames: { [batterOf(state)]: 'Alex L.' }
  }
})

describe('a prompt and a player name privacy', function () {
  for (const [label, format] of [
    ['A L', 'initials'],
    ['A Lee', 'initialLast'],
    ['Alex Lee', 'full']
  ] as const)
    it(`prints the model's name for a player labelled ${label}`, function () {
      const state = withModelNames(labelled(label, { nameFormat: format }))
      expect(promptContext(state)).include('Batter: Alex L.')
      expect(keyterms(state)).include('Alex L.')
      expect(rosterPrompt(state, ['away', 'home'])).include('Alex L.')
      expect(rosterPrompt(state, ['away', 'home'])).not.include('Lee')
    })

  it('reads a player with no model name from the label, surname out', function () {
    const state = labelled('Alex Van Der Berg', { nameFormat: 'full' })
    const player = state.gameData.players[batterOf(state)]
    expect(shortName(player)).equals('Alex B.')
    expect(modelNameOf(state, player)).equals('Alex B.')
    expect(shortName({ ...player, nameFormat: 'initialLast' })).equals(
      'Alex B.'
    )
  })

  it('leaves an unconfigured label as it was', function () {
    expect(shortName({ fullName: 'Mary Ann Smith' })).equals('Mary Ann S.')
    expect(
      drawnName({ fullName: 'Alex Lee', firstName: 'Alex', lastName: 'Lee' })
    ).equals('Alex L.')
  })

  it('draws the label however much the device holds', function () {
    const state = withModelNames(
      labelled('A L', { nameFormat: 'initials', halves: true })
    )
    const player = state.gameData.players[batterOf(state)]
    expect(drawnName(player)).equals('A L')
    expect(shortName(player)).equals('Alex L.')
    expect(modelNameOf(state, player)).equals('Alex L.')
  })

  it('hears a first name the label withholds', function () {
    const state = withModelNames(labelled('A L', { nameFormat: 'initials' }))
    const id = batterOf(state)
    expect(playerPatterns(state, id)[0]).equals('\\bAlex\\b')
    const silent = copyState(state)
    delete silent.meta.modelNames
    expect(playerPatterns(silent, id)[0]).equals('\\bA\\b')
  })

  it('resolves a spoken first name the label withholds', function () {
    const state = withModelNames(labelled('A L', { nameFormat: 'initials' }))
    const said = [
      {
        type: 'setPositions' as const,
        places: [{ player: { name: 'Alex' }, position: 'SS' as const }]
      }
    ]
    const { live, battingSide } = rosterSituation(state)
    expect(
      JSON.stringify(resolveRosterCommands(state, said, { live, battingSide }))
    ).include(String(batterOf(state)))
    const silent = copyState(state)
    delete silent.meta.modelNames
    expect(
      JSON.stringify(resolveRosterCommands(silent, said, { live, battingSide }))
    ).not.include(String(batterOf(state)))
  })

  it('falls through an empty model name', function () {
    const state = labelled('Alex L', {})
    const empty: GameState = {
      ...state,
      meta: { ...state.meta, modelNames: { [batterOf(state)]: '' } }
    }
    expect(playerPatterns(empty, batterOf(state))[0]).equals('\\bAlex\\b')
  })

  it('keeps the map through the cleaner', function () {
    const state = withModelNames(game())
    expect(asGameState(state).meta.modelNames).deep.equals(
      state.meta.modelNames
    )
  })
})

describe('a label on a client', function () {
  it('is drawn as sent in a chosen format', function () {
    for (const [label, format] of [
      ['Alex Lee', 'full'],
      ['A Lee', 'initialLast'],
      ['A L', 'initials']
    ] as const) {
      const state = labelled(label, { nameFormat: format })
      const id = batterOf(state)
      expect(namesOf(state).get(id)).equals(label)
      expect(
        shortPlayerNames(Object.values(state.gameData.players)).get(id)
      ).equals(label)
    }
  })

  it('is shortened as today with nothing chosen', function () {
    const state = labelled('Alex Lee', {})
    const id = batterOf(state)
    expect(namesOf(state).get(id)).equals('Alex L')
    expect(
      shortPlayerNames(Object.values(state.gameData.players)).get(id)
    ).equals('Alex L')
  })

  it('prints a surname whole on the field board', function () {
    const board = (
      fullName: string,
      nameFormat?: 'full' | 'initialLast'
    ): { firstName: string; lastName: string } =>
      scoreboardFor(labelled(fullName, { nameFormat })).batter
    expect(board('Alex Lee', 'full')).deep.equals({
      firstName: 'Alex Lee',
      lastName: ''
    })
    expect(board('A Lee', 'initialLast')).deep.equals({
      firstName: 'A Lee',
      lastName: ''
    })
    expect(board('A L')).deep.equals({ firstName: 'A', lastName: 'L' })
  })

  it('is drawn by a play description rather than the model name', function () {
    const state = withModelNames(
      labelled('A L', { nameFormat: 'initials', halves: true })
    )
    const id = batterOf(state)
    const action = {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: id,
      base: '2B'
    } as const
    const after = applyAction(state, action).state
    const said = JSON.stringify(describePlay(state, [action], after))
    expect(said).include('A L')
    expect(said).not.include('Alex')
  })
})

describe('a phone applying a post', function () {
  it('keeps the format of the cached game', function () {
    const setup = (fullName: string, nameFormat?: string): object => ({
      setupBefore: {
        players: {
          7: { id: 7, fullName, ...(nameFormat == null ? {} : { nameFormat }) }
        }
      },
      actions: []
    })
    const applied = appliedEvents(
      {
        plays: [],
        currentPlay: {
          about: { atBatIndex: 0 },
          teamStation: setup('Alex Lee', 'full')
        }
      },
      {
        currentPlay: {
          about: { atBatIndex: 0 },
          teamStation: setup('')
        }
      },
      {
        gameId: 'g1',
        plays: 'local-p',
        lineups: null,
        newPlayId: () => 'local-row',
        names: { 7: 'Alex Lee' }
      }
    ) as {
      currentPlay: {
        teamStation: {
          setupBefore: { players: Record<string, { nameFormat?: string }> }
        }
      }
    }
    expect(
      applied.currentPlay.teamStation.setupBefore.players[7].nameFormat
    ).equals('full')
  })
})

describe('a roster refresh', function () {
  it('moves the format with the label', function () {
    const state = copyState(game())
    const id = batterOf(state)
    const player = state.gameData.players[id]
    const row = (shortName: string): RosterEntry =>
      asRosterEntry({
        userId: userIdOfGumbo(id),
        gumboId: id,
        shortName,
        jersey: player.jersey,
        positions: [],
        isPlayer: true,
        role: 'member',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null
      })
    const refreshed = withRosterDetails(state, {
      [player.teamId]: [{ ...row('A Lee'), nameFormat: 'initialLast' }]
    })
    expect(refreshed.gameData.players[id]).deep.include({
      fullName: 'A Lee',
      nameFormat: 'initialLast'
    })
    const back = withRosterDetails(refreshed, {
      [player.teamId]: [row('Alex L')]
    })
    expect(back.gameData.players[id]).not.have.property('nameFormat')
  })
})

describe('a setup built from rosters', function () {
  it('carries the format a roster row holds', function () {
    const entry = {
      gumboId: 901,
      shortName: 'A L',
      nameFormat: 'initials' as const
    }
    const setup = newSetup(
      {
        away: { id: 'away', name: 'Away', logoUrl: null },
        home: { id: 'home', name: 'Home', logoUrl: null }
      },
      { away: [entry], home: [{ gumboId: 902, shortName: 'Riley C' }] }
    )
    expect(setup.players[901].nameFormat).equals('initials')
    expect(setup.players[902]).not.have.property('nameFormat')
  })

  it('carries it for a player added in the game', function () {
    const state = copyState(game())
    addRosteredPlayer(
      state,
      'home',
      { gumboId: 9901, shortName: 'A L', nameFormat: 'initials' },
      {
        firstName: 'Alex',
        lastName: 'Lee',
        jersey: '99',
        bats: 'right',
        throws: 'right',
        positions: []
      }
    )
    expect(state.gameData.players[9901].nameFormat).equals('initials')
    expect(drawnName(state.gameData.players[9901])).equals('A L')
  })
})

describe('a stored setup', function () {
  it('never holds a format', function () {
    const stored = withoutNames({
      teamStation: {
        version: 2,
        setupBefore: {
          players: { 1: { id: 1, fullName: 'A L', nameFormat: 'initials' } }
        },
        actions: []
      }
    }) as { teamStation: { setupBefore: { players: Record<string, object> } } }
    expect(stored.teamStation.setupBefore.players[1]).not.have.property(
      'nameFormat'
    )
  })
})

describe('a session holding model names', function () {
  const session = async (
    modelNames?: Record<string, string>
  ): Promise<ScoringSession> => {
    const state = game()
    const store: EventStore = {
      load: async () => ({
        plays: [],
        currentPlay: null,
        ...(modelNames == null ? {} : { modelNames })
      }),
      save: async () => await store.load('game')
    }
    return await ScoringSession.open(store, 'game', {
      gamePk: 'game',
      teams: {
        away: state.gameData.teams.away,
        home: state.gameData.teams.home
      },
      setup: {
        players: state.gameData.players,
        sides: {
          away: state.liveData.boxscore.teams.away,
          home: state.liveData.boxscore.teams.home
        },
        tagOrder: state.meta.tagOrder
      }
    })
  }

  it('answers them to whatever a screen starts from', async function () {
    const opened = await session({ 901: 'Alex L.' })
    const { state } = opened.resumable()
    expect(state.meta.modelNames).deep.equals({ 901: 'Alex L.' })
    expect(upcoming(state).state.meta.modelNames).deep.equals({
      901: 'Alex L.'
    })
    expect(opened.opening.meta.modelNames).deep.equals({ 901: 'Alex L.' })
    expect(opened.state.meta.modelNames).deep.equals({ 901: 'Alex L.' })
  })

  it('stages nothing for holding them', async function () {
    const plain = await session()
    const opened = await session({ 901: 'Alex L.' })
    expect(opened.actions).length(plain.actions.length)
    expect(opened.resumable().actions).length(plain.resumable().actions.length)
  })
})
