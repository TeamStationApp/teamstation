import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import {
  explicitPlaceholders,
  type RosterCommand,
  rosterSituation
} from '../../common/scoring/rosterCommands'
import type { GameState } from '../../common/scoring/state'
import { createDictatedPlayers } from './createDictatedPlayers'
import { createDevelopmentSession } from './developmentSession'
import { dictatedSheet } from './dictatedRoster'
import { gameFixture } from './isUnscoredGame.test'

describe('persistent dictated player creation', () => {
  const command: RosterCommand = {
    type: 'addPlayer',
    side: 'home',
    name: 'Shohei Ohtani',
    jersey: '17'
  }
  const game = (): GameState => createDevelopmentSession(gameFixture, [], [])
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
      player => player.userId === 7001
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
  it('creates explicit placeholders locally without a roster request', async () => {
    const draft = game()
    const result = await createDictatedPlayers(
      draft,
      [{ ...command, placeholder: true }],
      rosterSituation(draft),
      async () => {
        throw new Error('Must not call')
      }
    )
    if ('problem' in result) throw new Error(result.problem)
    expect(
      Object.values(result.draft.gameData.players).find(
        player => player.fullName === command.name
      )
    ).includes({ userId: null, local: true })
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
