import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { copyState } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { scoringSession } from '../../test/scoringSession'
import { guestRenames, sendGuestRenames } from './guestRenames'
import { gameFixture } from './isUnscoredGame.test'

describe('game-only player renames', function () {
  const opened = (): ReturnType<typeof scoringSession> => {
    const session = scoringSession(gameFixture)
    const [first, second] = session.liveData.boxscore.teams.away.players
    for (const id of [first, second]) session.gameData.players[id].local = true
    return session
  }

  it('finds each game-only player whose name the draft corrected', function () {
    const before = opened()
    const [first, second, third] = before.liveData.boxscore.teams.away.players
    const draft = copyState(before)
    Object.assign(draft.gameData.players[first], {
      firstName: 'Jose',
      lastName: 'Altuve',
      fullName: 'Jose Altuve'
    })
    // Halves set to what the name already says: still a correction.
    Object.assign(draft.gameData.players[second], {
      firstName: 'Kept',
      lastName: ''
    })
    // A rostered player is renamed on his team, not here.
    draft.gameData.players[third].fullName = 'Somebody Else'
    // A guest the draft made is named already.
    draft.gameData.players[999] = {
      ...draft.gameData.players[first],
      id: 999
    }
    expect(guestRenames(before, draft)).deep.equals([
      { gumboId: first, firstName: 'Jose', lastName: 'Altuve' },
      { gumboId: second, firstName: 'Kept', lastName: '' }
    ])
    // Nothing changed, or a name emptied: no rename.
    const emptied = copyState(before)
    Object.assign(emptied.gameData.players[first], {
      firstName: ' ',
      lastName: '',
      fullName: ''
    })
    expect(guestRenames(before, copyState(before))).deep.equals([])
    expect(guestRenames(before, emptied)).deep.equals([])
  })

  it('renames each through the client by his account, and refuses one it cannot find', async function () {
    const sent: unknown[] = []
    const answer = asRosterEntry({
      userId: userIdOfGumbo(901),
      gumboId: 901,
      shortName: 'George Ruth',
      jersey: null,
      positions: [],
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
    const client = {
      renameGuestPlayer: async (
        gameId: string,
        userId: string,
        name: { firstName: string; lastName: string },
        gumboId?: number | null
      ) => {
        sent.push({ gameId, userId, name, gumboId })
        return answer
      }
    }
    await sendGuestRenames(
      client,
      'g1',
      [{ gumboId: 901, firstName: 'George', lastName: 'Ruth' }],
      [
        { userId: userIdOfGumbo(900), gumboId: null },
        { userId: userIdOfGumbo(901), gumboId: 901 }
      ]
    )
    expect(sent).deep.equals([
      {
        gameId: 'g1',
        userId: userIdOfGumbo(901),
        name: { firstName: 'George', lastName: 'Ruth' },
        gumboId: 901
      }
    ])
    let refused: unknown
    try {
      await sendGuestRenames(
        client,
        'g1',
        [{ gumboId: 902, firstName: 'Lou', lastName: 'Gehrig' }],
        []
      )
    } catch (error) {
      refused = error
    }
    expect(String(refused)).includes('cannot be corrected here')
    expect(sent).has.length(1)
  })
})
