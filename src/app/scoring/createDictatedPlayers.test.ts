import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import {
  explicitPlaceholders,
  type RosterCommand,
  rosterSituation
} from '../../common/scoring/rosterCommands'
import type { GameState } from '../../common/scoring/state'
import { guestCreator } from '../../test/guestPlayers'
import { scoringSession } from '../../test/scoringSession'
import { createDictatedPlayers } from './createDictatedPlayers'
import { dictatedSheet } from './dictatedRoster'
import { gameFixture } from './isUnscoredGame.test'

describe('persistent dictated player creation', () => {
  const command: RosterCommand = {
    type: 'addPlayer',
    side: 'home',
    name: 'Shohei Ohtani',
    jersey: '17'
  }
  const game = (): GameState => scoringSession(gameFixture)
  it('creates a real roster identity by default and leaves the source draft untouched', async () => {
    const draft = game()
    const before = JSON.stringify(draft)
    const requests: unknown[] = []
    const result = await createDictatedPlayers(
      draft,
      [command],
      rosterSituation(draft),
      async (teamId, player) => {
        requests.push({ teamId, player })
        return asRosterEntry({
          userId: 7001,
          gumboId: 7001,
          shortName: 'Shohei O',
          isPlayer: true,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null,
          jersey: '17',
          positions: [],
          bats: 'right',
          throws: 'right'
        })
      }
    )
    expect(requests).length(1)
    expect(requests[0]).deep.includes({ teamId: draft.gameData.teams.home.id })
    expect('problem' in result).equals(false)
    if ('problem' in result) return
    const player = Object.values(result.draft.gameData.players).find(
      player => player.id === 7001
    )!
    expect(player).includes({
      local: false,
      firstName: 'Shohei',
      lastName: 'Ohtani',
      jersey: '17'
    })
    expect(result.draft.liveData.boxscore.teams.home.players).includes(
      player.id
    )
    expect(JSON.stringify(draft)).equals(before)
  })
  it('refuses an identity already held by the other team', async () => {
    const draft = game()
    const gumboId = draft.liveData.boxscore.teams.away.players[0]
    const result = await createDictatedPlayers(
      draft,
      [command],
      rosterSituation(draft),
      async () =>
        asRosterEntry({
          userId: 7001,
          gumboId,
          shortName: 'Shohei O',
          isPlayer: true,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null,
          jersey: '17',
          positions: [],
          bats: 'right',
          throws: 'right'
        })
    )
    expect(result).deep.equals({
      problem: 'The player belongs to the other team.'
    })
  })

  it('persists explicit placeholders as guests before staging them', async () => {
    const draft = game()
    const result = await createDictatedPlayers(
      draft,
      [{ ...command, placeholder: true }],
      rosterSituation(draft),
      async () => {
        throw new Error('Must not call')
      },
      () => true,
      new Map(),
      guestCreator()
    )
    if ('problem' in result) throw new Error(result.problem)
    expect(
      Object.values(result.draft.gameData.players).find(
        player => player.fullName === command.name
      )
    ).includes({ id: 9000000, local: true })
  })
  it('keeps identical guest requests distinct and reuses completed mints after a partial failure', async () => {
    const draft = game()
    const before = JSON.stringify(draft)
    const completed = new Map<string, RosterEntry>()
    const commands = [
      { ...command, placeholder: true },
      { ...command, placeholder: true }
    ]
    const mint = guestCreator()
    let calls = 0
    const createGuest: typeof mint = async (...args) => {
      if (++calls === 2) throw new Error('Temporarily unavailable')
      return await mint(...args)
    }
    let failed = false
    try {
      await createDictatedPlayers(
        draft,
        commands,
        rosterSituation(draft),
        undefined,
        () => true,
        completed,
        createGuest
      )
    } catch {
      failed = true
    }
    expect(failed).equals(true)
    expect(JSON.stringify(draft)).equals(before)
    const result = await createDictatedPlayers(
      draft,
      commands,
      rosterSituation(draft),
      undefined,
      () => true,
      completed,
      createGuest
    )
    if ('problem' in result) throw new Error(result.problem)
    expect(calls).equals(3)
    expect(
      result.draft.liveData.boxscore.teams.home.players.slice(-2)
    ).deep.equals([9000000, 9000001])
    expect(JSON.stringify(draft)).equals(before)
  })
  it('does not fall back to a placeholder when creation fails or is unavailable', async () => {
    const draft = game()
    const missing = await createDictatedPlayers(
      draft,
      [command],
      rosterSituation(draft),
      undefined
    )
    expect(missing).has.property('problem')
    let failure: unknown
    try {
      await createDictatedPlayers(
        draft,
        [command],
        rosterSituation(draft),
        async () => {
          throw new Error('Permission changed')
        }
      )
    } catch (error) {
      failure = error
    }
    expect((failure as Error).message).equals('Permission changed')
    expect(
      Object.values(draft.gameData.players).some(
        player => player.fullName === command.name
      )
    ).equals(false)
  })
  it('validates the whole sentence before any writes and stops when dismissed', async () => {
    const draft = game()
    let writes = 0
    const create = async (): Promise<never> => {
      writes++
      throw new Error('Unexpected write')
    }
    const invalid = await createDictatedPlayers(
      draft,
      [command, { ...command, jersey: 'abc' }],
      rosterSituation(draft),
      create
    )
    expect(invalid).has.property('problem')
    const dismissed = await createDictatedPlayers(
      draft,
      [command],
      rosterSituation(draft),
      create,
      () => false
    )
    expect(dismissed).has.property('problem')
    expect(writes).equals(0)
  })
  it('requires the word placeholder and defers scoring-screen creation to the persistent path', () => {
    expect(
      explicitPlaceholders(
        [{ ...command, placeholder: true }],
        'Create Shohei Ohtani'
      )[0].placeholder
    ).equals(false)
    expect(
      explicitPlaceholders(
        [{ ...command, placeholder: true }],
        'Create a placeholder Shohei Ohtani'
      )[0].placeholder
    ).equals(true)
    const draft = game()
    const sheet = dictatedSheet(draft, {
      transcript: 'Create Shohei Ohtani',
      commands: [command]
    })
    if ('problem' in sheet) throw new Error(sheet.problem)
    expect(sheet.pending).deep.equals([command])
    expect(sheet.draft).equals(draft)
  })
})
