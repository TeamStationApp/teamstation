import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  inProgressGame,
  MemoryStore,
  REPLAY_GAME_ID,
  replayContext,
  replaySetup
} from '../../test/replayGameFixture'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import {
  publicPlayer,
  withoutReaderNames,
  withReaderNames
} from './readerNames'
import { ScoringSession, type StoredGame } from './session'
import type { GamePlayer, GameState } from './state'

const player = (id: number, fullName: string): Record<string, unknown> => ({
  id,
  teamId: 'tem_replayPines',
  fullName,
  jersey: '50',
  bats: 'right',
  throws: 'right',
  positions: ['SS'],
  local: false
})

/** A play whose record holds Mookie Betts and Will Smith as the public reads them. */
function playOf(index: number): GumboPlay {
  return {
    about: { atBatIndex: index, inning: 1, halfInning: 'bottom' },
    matchup: {
      batter: { id: 9201, fullName: 'Mookie B' },
      pitcher: { id: 9109, fullName: 'Gerrit C' }
    },
    teamStation: {
      version: 2,
      setupBefore: {
        players: {
          9201: player(9201, 'Mookie B'),
          9204: player(9204, 'Will S')
        }
      },
      actions: [
        { type: 'pitch', call: 'B' },
        {
          type: 'lineup',
          kind: 'position',
          setup: { players: { 9201: player(9201, 'Mookie B') } }
        }
      ]
    }
  } as unknown as GumboPlay
}

describe('withReaderNames', function () {
  it('names each setup player its reader reads in full, keeping the public label', function () {
    const game: StoredGame = {
      plays: [playOf(0)],
      currentPlay: playOf(1) as unknown as CurrentPlay
    }
    const read = withReaderNames(game, { 9201: 'Mookie Betts' })
    for (const play of [read.plays[0], read.currentPlay]) {
      const record = (play as unknown as { teamStation: any }).teamStation
      expect(record.setupBefore.players[9201]).include({
        fullName: 'Mookie Betts',
        nameFormat: 'full',
        compactName: 'Mookie B'
      })
      expect(record.actions[1].setup.players[9201]).include({
        fullName: 'Mookie Betts',
        compactName: 'Mookie B'
      })
      // Nobody else, and the action with no setup, changes.
      expect(record.setupBefore.players[9204]).deep.equals(
        player(9204, 'Will S')
      )
      expect(record.actions[0]).deep.equals({ type: 'pitch', call: 'B' })
      // The shared record's references stay as everyone reads them.
      expect((play as any).matchup.batter.fullName).equals('Mookie B')
    }
    // The documents read are left as they were.
    expect(
      (game.plays[0] as any).teamStation.setupBefore.players[9201].fullName
    ).equals('Mookie B')
    // Again over its own answer: the same, the public label kept.
    const twice = withReaderNames(read, { 9201: 'Mookie Betts' })
    expect(twice).equals(read)
  })

  it('leaves a game it names nobody in, and a version 1 record, as they are', function () {
    const game: StoredGame = { plays: [playOf(0)], currentPlay: null }
    expect(withReaderNames(game, undefined)).equals(game)
    expect(withReaderNames(game, {})).equals(game)
    expect(withReaderNames(game, { 9999: 'Shohei Ohtani' })).equals(game)
    const legacy = playOf(0) as unknown as { teamStation: any }
    legacy.teamStation.version = 1
    const bare: Record<string, unknown> = { about: {} }
    const old: StoredGame = {
      plays: [legacy as unknown as GumboPlay, bare as GumboPlay],
      currentPlay: null
    }
    expect(withReaderNames(old, { 9201: 'Mookie Betts' })).equals(old)
  })

  it('keeps a compact name already held, and names one with no label', function () {
    const play = playOf(0) as unknown as { teamStation: any }
    play.teamStation.setupBefore.players[9201].compactName = 'Mookie B'
    play.teamStation.setupBefore.players[9201].fullName = 'Mookie Lee'
    delete play.teamStation.setupBefore.players[9204].fullName
    const read = withReaderNames(
      { plays: [play as unknown as GumboPlay], currentPlay: null },
      { 9201: 'Mookie Betts', 9204: 'Will Smith' }
    )
    const players = (read.plays[0] as any).teamStation.setupBefore.players
    expect(players[9201].compactName).equals('Mookie B')
    expect(players[9204]).include({ fullName: 'Will Smith', compactName: '' })
  })

  it('keeps the format of the label it replaces beside it', function () {
    const play = playOf(0) as unknown as { teamStation: any }
    Object.assign(play.teamStation.setupBefore.players[9201], {
      fullName: 'M Betts',
      nameFormat: 'initialLast'
    })
    const read = withReaderNames(
      { plays: [play as unknown as GumboPlay], currentPlay: null },
      { 9201: 'Mookie Betts', 9204: 'Will Smith' }
    )
    const players = (read.plays[0] as any).teamStation.setupBefore.players
    expect(players[9201]).include({
      fullName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'M Betts',
      compactFormat: 'initialLast'
    })
    // A built-in label carries no format beside it.
    expect(players[9204]).include({ compactName: 'Will S' })
    expect(players[9204]).not.have.property('compactFormat')
  })

  it('gives a session opened on it the full name, and the compact one beside', async function () {
    const store = new MemoryStore()
    const setup = replaySetup()
    const stored = await inProgressGame(setup)
    // The public label the server names him by, and the reader's full name.
    const publicGame: StoredGame = JSON.parse(
      JSON.stringify(stored).replaceAll('Mookie Betts', 'Mookie B')
    )
    const read = withReaderNames(publicGame, { 9201: 'Mookie Betts' })
    store.load = async () => read
    const session = await ScoringSession.open(
      store,
      REPLAY_GAME_ID,
      replayContext(setup),
      {
        now: () => new Date('2026-09-26T17:00:00Z'),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    expect(session.state.gameData.players[9201]).include({
      fullName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'Mookie B'
    })
  })
})

describe('withoutReaderNames', function () {
  const gamePlayer = (
    id: number,
    teamId: string,
    named: Partial<GamePlayer>
  ): GamePlayer => ({
    id,
    teamId,
    fullName: 'Mookie B',
    jersey: '50',
    bats: 'right',
    throws: 'right',
    positions: ['SS'],
    local: false,
    ...named
  })
  const betts = gamePlayer(9201, 'tem_away', {
    fullName: 'Mookie Betts',
    nameFormat: 'full',
    compactName: 'Mookie B'
  })
  const smith = gamePlayer(9204, 'tem_home', {
    fullName: 'Will Smith',
    nameFormat: 'full',
    compactName: 'W. Smith',
    compactFormat: 'initialLast'
  })
  const trout = gamePlayer(9301, 'tem_away', { fullName: 'Mike T' })
  const game = {
    gameData: { players: { 9201: betts, 9204: smith, 9301: trout } },
    gamePk: 'g1'
  } as unknown as GameState

  it('draws a player named in full only for his reader by the public label', function () {
    expect(publicPlayer(betts)).deep.equals(
      gamePlayer(9201, 'tem_away', { fullName: 'Mookie B' })
    )
    expect(publicPlayer(smith)).deep.equals(
      gamePlayer(9204, 'tem_home', {
        fullName: 'W. Smith',
        nameFormat: 'initialLast'
      })
    )
    // Already public: the same object.
    expect(publicPlayer(trout)).equals(trout)
  })
  it('hides only the teams it is asked to, leaving its input as it was', function () {
    const away = withoutReaderNames(game, team => team === 'tem_away')
    expect(away.gameData.players[9201].fullName).equals('Mookie B')
    expect(away.gameData.players[9201].compactName).equals(undefined)
    expect(away.gameData.players[9204]).equals(smith)
    expect(away.gameData.players[9301]).equals(trout)
    expect(away.gamePk).equals('g1')
    expect(game.gameData.players[9201]).equals(betts)
    const both = withoutReaderNames(game, () => true)
    expect(
      Object.values(both.gameData.players).map(player => player.fullName)
    ).deep.equals(['Mookie B', 'W. Smith', 'Mike T'])
  })
  it('gives back the same game when nobody it holds is hidden', function () {
    expect(withoutReaderNames(game, () => false)).equals(game)
    const short = {
      ...game,
      gameData: { players: { 9301: trout } }
    } as unknown as GameState
    expect(withoutReaderNames(short, () => true)).equals(short)
  })
})
