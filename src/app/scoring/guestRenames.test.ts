import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { copyState } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { scoringSession } from '../../test/scoringSession'
import { guestRenames, sendGuestRenames } from './guestRenames'
import { gameFixture } from './isUnscoredGame.test'
import { draftOfLocalPlayer, editLocalPlayerDraft } from './playerDraft'

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
    // Halves other than his short name split: a correction.
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

  it('takes an edit that keeps the halves for no correction, whether the game held them or not', function () {
    const before = opened()
    const [held, short] = before.liveData.boxscore.teams.away.players
    // As the scorer's read names him: his short name, and his halves.
    Object.assign(before.gameData.players[held], {
      fullName: 'Avery S',
      firstName: 'Avery',
      lastName: 'Smith'
    })
    // As a game read with no halves names him: his short name alone.
    Object.assign(before.gameData.players[short], {
      fullName: 'Avery S',
      firstName: undefined,
      lastName: undefined
    })
    const draft = copyState(before)
    // Only the jersey and the positions change, through the editor, which
    // rebuilds the whole name from the halves it started from.
    for (const id of [held, short])
      editLocalPlayerDraft(draft, 'away', id, {
        ...draftOfLocalPlayer(before.gameData.players[id]),
        jersey: '42',
        positions: ['SS']
      })
    expect(draft.gameData.players[held].fullName).equals('Avery Smith')
    expect(draft.gameData.players[short].jersey).equals('42')
    expect(guestRenames(before, draft)).deep.equals([])
    // Halves typed over the split short name are a correction.
    editLocalPlayerDraft(draft, 'away', short, {
      ...draftOfLocalPlayer(draft.gameData.players[short]),
      lastName: 'Smith'
    })
    expect(guestRenames(before, draft)).deep.equals([
      { gumboId: short, firstName: 'Avery', lastName: 'Smith' }
    ])
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
    // A guest added since the screen opened is looked up once, before any
    // correction is sent; one still unknown refuses them all.
    let lookUps = 0
    await sendGuestRenames(
      client,
      'g1',
      [
        { gumboId: 901, firstName: 'George', lastName: 'Ruth' },
        { gumboId: 902, firstName: 'Lou', lastName: 'Gehrig' }
      ],
      [{ userId: userIdOfGumbo(901), gumboId: 901 }],
      async () => {
        lookUps++
        return [{ userId: userIdOfGumbo(902), gumboId: 902 }]
      }
    )
    expect(lookUps).equals(1)
    expect(
      sent.slice(1).map(call => (call as { userId: string }).userId)
    ).deep.equals([userIdOfGumbo(901), userIdOfGumbo(902)])
    for (const lookUp of [
      async () => [],
      async () => {
        throw new Error('offline')
      }
    ]) {
      refused = undefined
      try {
        await sendGuestRenames(
          client,
          'g1',
          [
            { gumboId: 901, firstName: 'George', lastName: 'Ruth' },
            { gumboId: 903, firstName: 'Mel', lastName: 'Ott' }
          ],
          [{ userId: userIdOfGumbo(901), gumboId: 901 }],
          lookUp
        )
      } catch (error) {
        refused = error
      }
      expect(String(refused)).includes('cannot be corrected here')
      expect(sent).has.length(3)
    }
  })

  it('sends nothing for a pool player, who keeps their own name', async function () {
    const sent: string[] = []
    const client = {
      renameGuestPlayer: async (_game: string, userId: string) => {
        sent.push(userId)
        return undefined as never
      }
    }
    await sendGuestRenames(
      client,
      'g1',
      [{ gumboId: 904, firstName: 'Mookie', lastName: 'Betts' }],
      [{ userId: userIdOfGumbo(904), gumboId: 904, pool: true }]
    )
    expect(sent).deep.equals([])
  })
})
