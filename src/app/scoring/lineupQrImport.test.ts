import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { lineupQrFixture1, lineupQrFixture4 } from './lineupQr.fixtures'
import type { GameChangerLineup, GameChangerPlayer } from './lineupQrCodec'
import {
  applyLineupQr,
  type CreateGuest,
  fieldPosition,
  LineupQrGuestError,
  scannedJersey
} from './lineupQrImport'
import type { PlayerDraft } from './playerDraft'
import type { ScoringSessionState, Side } from './scoringTypes'

const PEOPLE = [
  ['Mookie', 'Betts', '1'],
  ['Mike', 'Trout', '2'],
  ['Shohei', 'Ohtani', '3'],
  ['Aaron', 'Judge', '4'],
  ['Bryce', 'Harper', '5'],
  ['Freddie', 'Freeman', '6'],
  ['Francisco', 'Lindor', '7'],
  ['Juan', 'Soto', '12'],
  ['Bobby', 'Witt', '99'],
  ['Julio', 'Rodríguez', '100']
] as const

/** A roster entry as a scorekeeper reads one: a short name, no name details. */
const entry = (
  gumboId: number,
  [first, last, jersey]: readonly string[],
  extra: Partial<RosterEntry> = {}
): RosterEntry => ({
  ...asRosterEntry({
    userId: userIdOfGumbo(gumboId),
    gumboId,
    shortName: `${first} ${last[0]}`,
    jersey,
    bats: 'switch',
    throws: 'left',
    positions: [],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  }),
  ...extra
})
const ROSTER = PEOPLE.map((person, k) => entry(100 + k, person))
let nextGuest = 1000
/** The server's guest creation: each guest a new gumbo id. */
const createGuest: CreateGuest = async (_side, player) =>
  entry(nextGuest++, [player.firstName, player.lastName, player.jersey], {
    isPlayer: false
  })
/** A scan of a code into the away side, with guests made as the server would. */
const scan = async (
  draft: ScoringSessionState,
  side: Side,
  lineup: GameChangerLineup,
  roster: readonly RosterEntry[]
): ReturnType<typeof applyLineupQr> =>
  await applyLineupQr(draft, side, lineup, roster, createGuest)
/** Ten roster players in the away game: all ten bat, the first nine field. */
const session = (roster = ROSTER): ScoringSessionState =>
  createDevelopmentSession(gameFixture, roster, [])
const scanned = (
  f: string,
  l: string,
  n: string,
  p: number
): GameChangerPlayer => ({
  i: '00000000-0000-4000-8000-000000000000',
  f,
  l,
  n,
  p
})
const code = (
  h: GameChangerPlayer[],
  n: GameChangerPlayer[] = []
): GameChangerLineup => ({ e: 'e', t: 't', h, n })
const side = (
  state: ScoringSessionState
): {
  order: string[]
  defense: Record<string, string | null>
  players: number
} => {
  const team = state.liveData.boxscore.teams.away
  const name = (id: number): string => state.gameData.players[id].fullName
  return {
    order: team.battingOrder.map(name),
    defense: Object.fromEntries(
      Object.entries(team.defense).map(([position, id]) => [
        position,
        id == null ? null : name(id)
      ])
    ),
    players: team.players.length
  }
}
/** A side with nobody on it (an empty roster otherwise gets placeholders). */
const empty = (): ScoringSessionState => {
  const state = session([])
  const team = state.liveData.boxscore.teams.away
  team.players = []
  team.battingOrder = []
  for (const position of Object.keys(team.defense) as Array<
    keyof typeof team.defense
  >)
    team.defense[position] = null
  return state
}

describe('lineup QR import under a chosen format', function () {
  /** Whether a scanned player lands on the roster row labelled `label`. */
  const matched = async (
    label: string,
    nameFormat: 'initials' | 'initialLast' | undefined,
    first: string,
    last: string
  ): Promise<boolean> => {
    const entry = { ...ROSTER[0], shortName: label, nameFormat, jersey: '77' }
    const { draft } = await scan(
      empty(),
      'away',
      { ...lineupQrFixture4.lineup, h: [scanned(first, last, '77', 6)] },
      [entry]
    )
    return draft.gameData.players[entry.gumboId!] != null
  }

  it('matches a label the format abbreviated', async function () {
    expect(await matched('A L', 'initials', 'Alex', 'Lee')).equals(true)
    expect(await matched('A Lee', 'initialLast', 'Alex', 'Lee')).equals(true)
    expect(await matched('B L', 'initials', 'Alex', 'Lee')).equals(false)
    expect(await matched('A', 'initials', 'Alex', 'Lee')).equals(false)
  })

  it('keeps the built-in rule', async function () {
    expect(await matched('Alex L', undefined, 'Alex', 'Lee')).equals(true)
    expect(await matched('Alex L', undefined, 'Alexander', 'Lee')).equals(false)
  })
})

describe('lineup QR import', function () {
  it('adds every player of a code to an empty side, in order and in place', async function () {
    const { draft, added, reused, benched } = await scan(
      empty(),
      'away',
      lineupQrFixture4.lineup,
      []
    )
    expect(added).has.length(12)
    expect(reused).deep.equals([])
    expect(benched).deep.equals([])
    const view = side(draft)
    expect(view.order).deep.equals(
      lineupQrFixture4.lineup.h.map(p => `${p.f} ${p.l}`)
    )
    expect(view.defense.P).equals('Gerrit Cole')
    expect(view.order).not.includes('Gerrit Cole')
    expect(view.defense.CF).equals('Corey Seager')
    expect(view.defense.SS).equals('José Ramírez')
    const team = draft.liveData.boxscore.teams.away
    const first = draft.gameData.players[team.battingOrder[0]]
    expect(first).deep.include({
      firstName: 'Corey',
      lastName: 'Seager',
      jersey: '5',
      local: true
    })
  })

  it('changes nothing when the same code is scanned again', async function () {
    const once = await scan(empty(), 'away', lineupQrFixture4.lineup, [])
    const twice = await scan(once.draft, 'away', lineupQrFixture4.lineup, [])
    expect(twice.draft).deep.equals(once.draft)
    expect(twice.added).deep.equals([])
    expect(twice.reused).has.length(12)
    expect(twice.benched).deep.equals([])
  })

  it('reuses a game player of the same name and jersey and moves him', async function () {
    const { draft, added, reused } = await scan(
      session(),
      'away',
      code([
        scanned('Bobby', 'Witt', '99', 10),
        scanned('JULIO', 'Rodriguez', ' 100 ', 7)
      ]),
      ROSTER
    )
    expect(added).deep.equals([])
    expect(reused).deep.equals(['Bobby W', 'Julio R'])
    const view = side(draft)
    expect(view.players).equals(10)
    expect(view.order.slice(0, 2)).deep.equals(['Bobby W', 'Julio R'])
    expect(view.defense.SS).equals('Bobby W')
    expect(view.defense.LF).equals('Julio R')
  })

  it('reads a lengthened short name as the same player', async function () {
    const roster = ROSTER.map((person, k) =>
      k === 0 ? { ...person, shortName: 'Mookie Be' } : person
    )
    const state = session(roster)
    const { reused, added } = await scan(
      state,
      'away',
      code([scanned('Mookie', 'Betts', '1', 6)]),
      roster
    )
    expect(added).deep.equals([])
    expect(reused).deep.equals(['Mookie Be'])
  })

  it('joins a roster player who is not in the game with his own details', async function () {
    const bench = entry(200, ['Ronald', 'Acuna', '13'], {
      bats: null,
      throws: null,
      jersey: null,
      positions: ['LF', 'CF']
    })
    const joining = entry(201, ['Corey', 'Seager', '5'], { positions: ['SS'] })
    const { draft, added, reused } = await scan(
      session(),
      'away',
      code([
        scanned('Corey', 'Seager', '#5', 2),
        scanned('Ronald', 'Acuna', '', 7)
      ]),
      [...ROSTER, joining, bench]
    )
    expect(added).deep.equals([])
    expect(reused).deep.equals(['Corey S', 'Ronald A'])
    const team = draft.liveData.boxscore.teams.away
    const corey = draft.gameData.players[team.battingOrder[0]]
    expect(corey).deep.include({
      id: 201,
      local: false,
      bats: 'switch',
      throws: 'left',
      positions: ['SS'],
      jersey: '5'
    })
    const ronald = draft.gameData.players[team.battingOrder[1]]
    expect(ronald).deep.include({
      id: 200,
      bats: 'right',
      throws: 'right',
      jersey: '',
      positions: ['LF', 'CF']
    })
  })

  it('makes a new player when the jersey differs', async function () {
    const { added, reused } = await scan(
      session(),
      'away',
      code([scanned('Mookie', 'Betts', '50', 6)]),
      ROSTER
    )
    expect(added).deep.equals(['Mookie Betts'])
    expect(reused).deep.equals([])
  })

  it('keeps a jersey of one to three digits, without a #, and drops any other', async function () {
    expect(scannedJersey('#7')).equals('7')
    expect(scannedJersey(' 07 ')).equals('07')
    expect(scannedJersey('1234')).equals('')
    expect(scannedJersey('A1')).equals('')
    const { draft } = await scan(
      empty(),
      'away',
      code([
        scanned('Pete', 'Alonso', '1234', 3),
        scanned('Will', 'Smith', 'A1', 5)
      ]),
      []
    )
    const team = draft.liveData.boxscore.teams.away
    expect(
      team.battingOrder.map(id => draft.gameData.players[id].jersey)
    ).deep.equals(['', ''])
  })

  it('benches whoever held a scanned batter’s slot or a scanned fielder’s place', async function () {
    const { draft, benched } = await scan(
      session(),
      'away',
      code([
        scanned('Mookie', 'Betts', '1', 4),
        scanned('Mike', 'Trout', '2', 5),
        scanned('Corey', 'Seager', '5', 10)
      ]),
      ROSTER
    )
    // Slot 3 was Shohei O's; SS was Bryce H's (the fifth batter).
    expect(benched).deep.equals(['Shohei O', 'Bryce H'])
    const view = side(draft)
    expect(view.order).deep.equals([
      'Mookie B',
      'Mike T',
      'Corey Seager',
      'Aaron J',
      'Freddie F',
      'Francisco L',
      'Juan S',
      'Bobby W',
      'Julio R'
    ])
    expect(view.defense.SS).equals('Corey Seager')
    expect(view.defense['1B']).equals(null)
    expect(Object.values(view.defense)).not.includes('Bryce H')
    expect(view.players).equals(11)
  })

  it('moves a reused batter without leaving him in the order twice', async function () {
    const { draft, benched } = await scan(
      session(),
      'away',
      code([
        scanned('Mookie', 'Betts', '1', 4),
        scanned('Bryce', 'Harper', '5', 10)
      ]),
      ROSTER
    )
    expect(benched).deep.equals(['Mike T'])
    const order = side(draft).order
    expect(order.slice(0, 2)).deep.equals(['Mookie B', 'Bryce H'])
    expect(order.filter(name => name === 'Bryce H')).has.length(1)
    expect(order).has.length(9)
  })

  it('puts a fielder who does not bat on the field and out of the order', async function () {
    const { draft } = await scan(
      session(),
      'away',
      code(
        [scanned('Mookie', 'Betts', '1', 6)],
        [scanned('Aaron', 'Judge', '4', 104)]
      ),
      ROSTER
    )
    const view = side(draft)
    expect(view.defense.P).equals('Aaron J')
    expect(view.defense.CF).equals('Mookie B')
    expect(view.order).not.includes('Aaron J')
    // Juan S held CF; Mookie B's place there benches him.
    expect(view.order).not.includes('Juan S')
  })

  it('reads plain codes in the fielders who do not bat, and lets a later pitcher take the mound', async function () {
    const { draft, benched } = await scan(
      empty(),
      'away',
      lineupQrFixture1.lineup,
      []
    )
    const view = side(draft)
    expect(benched).deep.equals([])
    expect(view.order).has.length(6)
    expect(view.defense['1B']).equals('Spencer Strider')
    expect(view.defense.RF).equals('Kyle Tucker')
    expect(view.order).not.includes('Spencer Strider')
    // Gerrit Cole bats as a P, and no one else is a P, so he keeps it.
    expect(view.defense.P).equals('Gerrit Cole')
  })

  it('gives no place for a Roamer, an EH, a DH or an unknown code', async function () {
    for (const p of [9, 11, 12, 99])
      expect(fieldPosition(p), String(p)).equals(undefined)
    expect(fieldPosition(104)).equals('P')
    const { draft } = await scan(
      empty(),
      'away',
      code([
        scanned('A', 'One', '1', 9),
        scanned('B', 'Two', '2', 11),
        scanned('C', 'Three', '3', 12),
        scanned('D', 'Four', '4', 99)
      ]),
      []
    )
    const view = side(draft)
    expect(view.order).has.length(4)
    expect(Object.values(view.defense).every(holder => holder == null)).equals(
      true
    )
  })

  it('leaves two scanned pitchers in the order, the later one on the mound', async function () {
    const { draft, benched } = await scan(
      empty(),
      'away',
      code([
        scanned('Gerrit', 'Cole', '45', 4),
        scanned('Zack', 'Wheeler', '45', 4)
      ]),
      []
    )
    expect(benched).deep.equals([])
    const view = side(draft)
    expect(view.order).deep.equals(['Gerrit Cole', 'Zack Wheeler'])
    expect(view.defense.P).equals('Zack Wheeler')
  })

  it('places a roster player already in the game once, as he is', async function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    // Bobby W (roster #99) wears 17 in this game, with an unsaved left bat.
    const bobby = team.battingOrder[8]
    Object.assign(state.gameData.players[bobby], { jersey: '17', bats: 'left' })
    const { draft, added, reused } = await scan(
      state,
      'away',
      code([
        scanned('Bobby', 'Witt', '99', 10),
        // The same player again, as a second row of the code.
        scanned('Bobby', 'Witt', '99', 8)
      ]),
      ROSTER
    )
    const after = draft.liveData.boxscore.teams.away
    expect(after.battingOrder.filter(id => id === bobby)).has.length(1)
    expect(draft.gameData.players[bobby]).deep.include({
      jersey: '17',
      bats: 'left'
    })
    expect(reused).deep.equals(['Bobby W'])
    expect(added).deep.equals(['Bobby Witt'])
  })

  it('joins a roster player with empty name details under the scanned name', async function () {
    const blank = entry(300, ['Ronald', 'Acuna', '13'], {
      nameDetails: { firstName: '', lastName: '', displayName: '' }
    })
    const { draft, reused } = await scan(
      session(),
      'away',
      code([scanned('Ronald', 'Acuna', '13', 7)]),
      [...ROSTER, blank]
    )
    expect(reused).deep.equals(['Ronald A'])
    const team = draft.liveData.boxscore.teams.away
    expect(draft.gameData.players[team.battingOrder[0]]).deep.include({
      firstName: 'Ronald',
      lastName: 'Acuna',
      id: 300
    })
  })

  it('counts a fielder who does not bat and found no place as benched', async function () {
    const { draft, benched } = await scan(
      empty(),
      'away',
      code(
        [scanned('Pete', 'Alonso', '20', 3)],
        [scanned('Cal', 'Raleigh', '29', 109)]
      ),
      []
    )
    expect(benched).deep.equals(['Cal Raleigh'])
    const team = draft.liveData.boxscore.teams.away
    const cal = team.players.find(
      id => draft.gameData.players[id].fullName === 'Cal Raleigh'
    )!
    expect(team.battingOrder).not.includes(cal)
    expect(Object.values(team.defense)).not.includes(cal)
  })

  it('leaves the draft it was given unchanged', async function () {
    const state = session()
    const before = JSON.stringify(state)
    await scan(state, 'away', lineupQrFixture4.lineup, ROSTER)
    expect(JSON.stringify(state)).equals(before)
  })

  it('makes each new player a guest of the side through the server', async function () {
    const made: Array<[Side, PlayerDraft]> = []
    const { draft, added } = await applyLineupQr(
      empty(),
      'away',
      code([scanned(' Pete ', 'Alonso', '#20', 3)]),
      [],
      async (side, player) => {
        made.push([side, player])
        return await createGuest(side, player)
      }
    )
    expect(made).deep.equals([
      [
        'away',
        {
          firstName: 'Pete',
          lastName: 'Alonso',
          jersey: '20',
          bats: 'right',
          throws: 'right',
          positions: []
        }
      ]
    ])
    expect(added).deep.equals(['Pete Alonso'])
    const id = draft.liveData.boxscore.teams.away.battingOrder[0]
    expect(draft.gameData.players[id]).deep.include({
      local: true,
      jersey: '20'
    })
    expect(draft.meta.tagOrder).includes(id)
  })

  it('fails a scan whose guest the server refused, and makes no guest twice when it is retried', async function () {
    const lineup = code([
      scanned('Pete', 'Alonso', '20', 3),
      scanned('Cal', 'Raleigh', '29', 5)
    ])
    const created = new Map<string, RosterEntry>()
    const made: string[] = []
    let fail = true
    const flaky: CreateGuest = async (side, player) => {
      if (player.firstName === 'Cal' && fail) throw new Error('offline')
      made.push(player.firstName)
      return await createGuest(side, player)
    }
    const failure = await applyLineupQr(
      empty(),
      'away',
      lineup,
      [],
      flaky,
      created
    ).catch((error: unknown) => error)
    expect(failure).instanceOf(LineupQrGuestError)
    expect((failure as Error).cause).deep.equals(new Error('offline'))
    fail = false
    const { added } = await applyLineupQr(
      empty(),
      'away',
      lineup,
      [],
      flaky,
      created
    )
    expect(added).deep.equals(['Pete Alonso', 'Cal Raleigh'])
    expect(made).deep.equals(['Pete', 'Cal'])
  })

  it('needs no guest creation when every scanned player is on the team', async function () {
    const lineup = code([scanned('Mookie', 'Betts', '1', 6)])
    const { reused } = await applyLineupQr(
      session(),
      'away',
      lineup,
      ROSTER,
      undefined
    )
    expect(reused).deep.equals(['Mookie B'])
    const failure = await applyLineupQr(
      empty(),
      'away',
      lineup,
      [],
      undefined
    ).catch((error: unknown) => error)
    expect(failure).instanceOf(LineupQrGuestError)
  })

  it('makes a guest of a roster entry with no gumbo id', async function () {
    const unknown = { ...entry(400, ['Ronald', 'Acuna', '13']), gumboId: null }
    const { added, reused } = await scan(
      session(),
      'away',
      code([scanned('Ronald', 'Acuna', '13', 7)]),
      [...ROSTER, unknown]
    )
    expect(reused).deep.equals([])
    expect(added).deep.equals(['Ronald Acuna'])
  })
})
