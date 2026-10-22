import type { CurrentPlay, GumboPlay } from '../common/gumboPlay'
import type { ScoringAction } from '../common/scoring/actions'
import { applyAction } from '../common/scoring/apply'
import { freshGame, newSetup } from '../common/scoring/lineup'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type SessionContext,
  type StoredGame
} from '../common/scoring/session'
import type {
  GameSetup,
  GameState,
  Position,
  Side
} from '../common/scoring/state'

/**
 * A three-inning game scored in TeamStation, for the replay's tests and its
 * seed. It is scored the way the scoring screen scores, through a
 * `ScoringSession`, into a server held in memory, so the stored plays and
 * their records are exactly what the server would hold.
 *
 * The players carry major leaguers' public names, or invented ones where a
 * name would match a real person outside the game; the teams are made up.
 */
export const REPLAY_TEAMS = {
  away: { id: 'tem_replayHawks', name: 'Harbor Hawks' },
  home: { id: 'tem_replayPines', name: 'Valley Pines' }
}

export interface Player {
  /** The player's persistent scoring id, which names them in the game. */
  gumboId: number
  first: string
  last: string
  position?: Position
}

/** The visitors, in batting order, then the bench. */
export const AWAY_PLAYERS: Player[] = [
  { gumboId: 9101, first: 'Juan', last: 'Soto', position: 'LF' },
  { gumboId: 9102, first: 'Aaron', last: 'Judge', position: 'RF' },
  { gumboId: 9103, first: 'Anthony', last: 'Rizzo', position: '1B' },
  { gumboId: 9104, first: 'Gleyber', last: 'Torres', position: '2B' },
  { gumboId: 9105, first: 'Anthony', last: 'Volpe', position: 'SS' },
  { gumboId: 9106, first: 'Luis', last: 'Garcia', position: '3B' },
  { gumboId: 9107, first: 'Jose', last: 'Trevino', position: 'C' },
  { gumboId: 9108, first: 'Harrison', last: 'Bader', position: 'CF' },
  { gumboId: 9109, first: 'Gerrit', last: 'Cole', position: 'P' },
  { gumboId: 9110, first: 'Giancarlo', last: 'Stanton' },
  { gumboId: 9111, first: 'Luis', last: 'Gil' }
]
/** The home side, in batting order, then the bench. */
export const HOME_PLAYERS: Player[] = [
  { gumboId: 9201, first: 'Mookie', last: 'Betts', position: 'SS' },
  { gumboId: 9202, first: 'Freddie', last: 'Freeman', position: '1B' },
  { gumboId: 9203, first: 'Shohei', last: 'Ohtani', position: 'LF' },
  { gumboId: 9204, first: 'Will', last: 'Smith', position: 'C' },
  { gumboId: 9205, first: 'Max', last: 'Muncy', position: '3B' },
  { gumboId: 9206, first: 'Teoscar', last: 'Hernandez', position: 'RF' },
  { gumboId: 9207, first: 'Rowan', last: 'Pell', position: '2B' },
  { gumboId: 9208, first: 'James', last: 'Outman', position: 'CF' },
  { gumboId: 9209, first: 'Tyler', last: 'Glasnow', position: 'P' },
  { gumboId: 9210, first: 'Evan', last: 'Phillips' }
]

/**
 * Both lineups, with the batting orders and the defence above. `gumboIdOf`
 * gives each player's scoring id; a seed passes the ids it allocated.
 */
export function replaySetup(
  gumboIdOf: (player: Player) => number = player => player.gumboId
): GameSetup {
  const roster = (
    players: Player[]
  ): Array<{
    gumboId: number
    shortName: string
  }> =>
    players.map(player => ({
      gumboId: gumboIdOf(player),
      shortName: `${player.first} ${player.last}`
    }))
  const setup = newSetup(
    REPLAY_TEAMS,
    { away: roster(AWAY_PLAYERS), home: roster(HOME_PLAYERS) },
    false
  )
  for (const [side, players] of [
    ['away', AWAY_PLAYERS],
    ['home', HOME_PLAYERS]
  ] as Array<[Side, Player[]]>) {
    const team = setup.sides[side]
    for (const player of players) {
      const record = setup.players[gumboIdOf(player)]
      record.firstName = player.first
      record.lastName = player.last
    }
    const starters = players.filter(player => player.position != null)
    team.battingOrder = starters.map(gumboIdOf)
    team.battingIndex = 0
    for (const position of Object.keys(team.defense) as Position[])
      team.defense[position] = null
    for (const player of starters)
      team.defense[player.position!] = gumboIdOf(player)
  }
  return setup
}

/** A server in memory, keeping what each save sends as the server would. */
export class MemoryStore implements EventStore {
  plays = new Map<number, GumboPlay>()
  current: CurrentPlay | null = null

  async load(): Promise<StoredGame> {
    return this.stored()
  }

  async save(_gameId: string, change: SaveChange): Promise<StoredGame> {
    for (const index of change.remove) this.plays.delete(index)
    for (const play of change.plays) this.plays.set(play.about.atBatIndex, play)
    if (change.currentPlay !== undefined) this.current = change.currentPlay
    return this.stored()
  }

  stored(): StoredGame {
    return JSON.parse(
      JSON.stringify({
        plays: [...this.plays.values()].sort(
          (a, b) => a.about.atBatIndex - b.about.atBatIndex
        ),
        currentPlay: this.current
      })
    ) as StoredGame
  }
}

export const REPLAY_GAME_ID = 'gam_replayFixture'

export function replayContext(setup = replaySetup()): SessionContext {
  return { gamePk: REPLAY_GAME_ID, teams: REPLAY_TEAMS, setup }
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const pitch = (call: 'B' | 'C' | 'S' | 'F' | 'T'): ScoringAction => ({
  type: 'pitch',
  call
})

/**
 * Every action of the game, as the scorer took them. Visitors bat first;
 * the home side leads 3–2 after two and wins without batting in the third.
 */
export function replayActions(setup = replaySetup()): ScoringAction[] {
  // Players follow the roster's order, whatever their scoring ids are.
  const a = (index: number): number => setup.sides.away.players[index]
  const h = (index: number): number => setup.sides.home.players[index]
  const [soto, , rizzo, , volpe, , , bader, cole, stanton, gil] =
    AWAY_PLAYERS.map((_, i) => a(i))
  const [betts, freeman, , , muncy, , , outman] = HOME_PLAYERS.map((_, i) =>
    h(i)
  )
  return [
    // Top of the 1st.
    // Soto walks.
    pitch('B'),
    pitch('B'),
    pitch('C'),
    pitch('B'),
    pitch('B'),
    close,
    // Judge is called out on strikes.
    pitch('S'),
    pitch('F'),
    pitch('C'),
    close,
    // Soto steals second; Rizzo singles to left and Soto scores.
    pitch('B'),
    { type: 'baseRunning', kind: 'steal', runner: soto, to: '2B' },
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 12,
      location: { x: -45, z: -75 },
      fielder: h(2)
    },
    { type: 'result', eventType: 'single' },
    { type: 'runnerMovement', runner: soto, to: 'home', reason: 'Advance' },
    close,
    // Torres grounds into a double play, short to second to first.
    pitch('F'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: -8,
      location: { x: -12, z: -32 },
      fielder: betts
    },
    { type: 'result', eventType: 'field_out' },
    {
      type: 'runnerMovement',
      runner: rizzo,
      to: '2B',
      out: true,
      fielders: [betts, h(6)]
    },
    {
      type: 'runnerMovement',
      runner: a(3),
      to: '1B',
      out: true,
      fielders: [h(6), freeman]
    },
    close,
    // Bottom of the 1st.
    // Betts homers over the left-field wall on an angle the scorer dragged.
    pitch('C'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 31.5,
      launchAngleDragged: true,
      location: { x: -40, z: -128 },
      homeRunKind: 'out-of-park'
    },
    { type: 'result', eventType: 'home_run' },
    close,
    // Freeman strikes out swinging on a foul tip.
    pitch('C'),
    pitch('F'),
    pitch('T'),
    close,
    // Ohtani flies out to center.
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 38,
      location: { x: 4, z: -92 },
      fielder: a(7)
    },
    { type: 'result', eventType: 'field_out', outBy: 'catch' },
    close,
    // Gil relieves Cole, and Smith grounds out to short.
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: gil,
      replaces: cole,
      position: 'P'
    },
    pitch('B'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: -4,
      location: { x: -14, z: -30 },
      fielder: volpe
    },
    { type: 'result', eventType: 'field_out', outBy: 'throw' },
    {
      type: 'runnerMovement',
      runner: h(3),
      to: '1B',
      out: true,
      fielders: [volpe, rizzo]
    },
    close,
    // Top of the 2nd.
    // Volpe reaches on Betts's fielding error.
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: -6,
      location: { x: -10, z: -34 },
      fielder: betts
    },
    { type: 'result', eventType: 'field_error' },
    { type: 'fieldingPlay', fielders: [betts], error: betts },
    close,
    // A wild pitch moves Volpe to second; Garcia singles him to third.
    pitch('B'),
    {
      type: 'batteryEvent',
      kind: 'wild_pitch',
      advances: [{ runner: volpe, to: '2B' }]
    },
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 8,
      location: { x: 30, z: -70 },
      fielder: h(5)
    },
    { type: 'result', eventType: 'single' },
    close,
    // Trevino's fly to center scores Volpe: a sacrifice fly.
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 40,
      location: { x: 0, z: -95 },
      fielder: outman
    },
    { type: 'result', eventType: 'field_out', outBy: 'catch' },
    { type: 'runnerMovement', runner: volpe, to: 'home', reason: 'Advance' },
    close,
    // Stanton pinch-hits for Bader and strikes out swinging.
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: stanton,
      replaces: bader
    },
    pitch('S'),
    pitch('S'),
    pitch('S'),
    close,
    // Gil grounds out, third to first.
    pitch('C'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: -10,
      location: { x: 18, z: -28 },
      fielder: muncy
    },
    { type: 'result', eventType: 'field_out', outBy: 'throw' },
    {
      type: 'runnerMovement',
      runner: gil,
      to: '1B',
      out: true,
      fielders: [muncy, freeman]
    },
    close,
    // Bottom of the 2nd: Stanton stays in, in center field.
    {
      type: 'lineup',
      kind: 'position',
      side: 'away',
      position: 'CF',
      player: stanton
    },
    // Muncy singles to right.
    pitch('B'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 9,
      location: { x: 40, z: -72 },
      fielder: a(1)
    },
    { type: 'result', eventType: 'single' },
    close,
    // Hernandez hits it off the wall in center and circles the bases.
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 22,
      location: { x: 20, z: -110 },
      fielder: stanton,
      landingHeight: 2,
      homeRunKind: 'in-park'
    },
    { type: 'result', eventType: 'home_run' },
    close,
    // Pell, Outman and Glasnow strike out.
    pitch('C'),
    pitch('C'),
    pitch('C'),
    close,
    pitch('S'),
    pitch('C'),
    pitch('S'),
    close,
    pitch('C'),
    pitch('S'),
    pitch('C'),
    close,
    // Top of the 3rd: three up, three down, and the home side wins.
    pitch('C'),
    pitch('C'),
    pitch('C'),
    close,
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 50,
      location: { x: -8, z: -40 },
      fielder: h(6)
    },
    { type: 'result', eventType: 'field_out', outBy: 'catch' },
    close,
    pitch('S'),
    pitch('S'),
    pitch('S'),
    close,
    { type: 'gameFlow', kind: 'endGame' }
  ]
}

/**
 * A short game for the announcer's runs: three walks load the bases in the
 * top of the 1st, a grand slam clears them, three strikeouts end the half,
 * and the scorer ends the game there.
 */
export function rallyActions(): ScoringAction[] {
  const walk = [pitch('B'), pitch('B'), pitch('B'), pitch('B'), close]
  const strikeout = [pitch('S'), pitch('S'), pitch('S'), close]
  return [
    ...walk,
    ...walk,
    ...walk,
    pitch('C'),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 31.5,
      launchAngleDragged: true,
      location: { x: -40, z: -128 },
      homeRunKind: 'out-of-park'
    },
    { type: 'result', eventType: 'home_run' },
    close,
    ...strikeout,
    ...strikeout,
    ...strikeout,
    { type: 'gameFlow', kind: 'endGame' }
  ]
}

/** The rally game, finished. */
export async function rallyGame(setup = replaySetup()): Promise<StoredGame> {
  return await scored(rallyActions(), setup)
}

/** Scores the actions and returns what the server holds after them. */
export async function scored(
  actions: ScoringAction[],
  setup = replaySetup(),
  store = new MemoryStore()
): Promise<StoredGame> {
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
  for (const [index, action] of actions.entries()) {
    const applied = session.apply(action)
    if (applied.problems.length > 0)
      throw new Error(
        `action ${index} ${JSON.stringify(action)}: ${applied.problems[0].message}`
      )
  }
  await session.flush()
  return store.stored()
}

/** The finished game. */
export async function finalGame(setup = replaySetup()): Promise<StoredGame> {
  return await scored(replayActions(setup), setup)
}

/**
 * The game in progress: cut in the middle of Muncy's at-bat in the bottom of
 * the 2nd, after Stanton moves to center and Gil's first pitch to Muncy.
 */
export async function inProgressGame(
  setup = replaySetup()
): Promise<StoredGame> {
  const actions = replayActions(setup)
  const cut = actions.findIndex(
    (action, i) =>
      action.type === 'pitch' &&
      i > 0 &&
      actions[i - 1].type === 'lineup' &&
      (actions[i - 1] as { kind?: string }).kind === 'position'
  )
  return await scored(actions.slice(0, cut + 1), setup)
}

/** The finished game, with the last out turned into a single and the game left open. */
export async function correctedGame(): Promise<StoredGame> {
  const actions = replayActions().slice(0, -1)
  const lastBall = actions.findLastIndex(action => action.type === 'pitch')
  return await scored([
    ...actions.slice(0, lastBall),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 10,
      location: { x: 30, z: -75 },
      fielder: replaySetup().sides.home.players[5]
    },
    { type: 'result', eventType: 'single' },
    close
  ])
}

/** The index of the first action taken in the given half. */
export function firstActionOfHalf(
  actions: readonly ScoringAction[],
  inning: number,
  half: 'top' | 'bottom',
  setup = replaySetup()
): number {
  let state = freshGame(REPLAY_GAME_ID, REPLAY_TEAMS, setup)
  for (const [index, action] of actions.entries()) {
    const linescore = state.liveData.linescore
    if (
      linescore.currentInning === inning &&
      linescore.isTopInning === (half === 'top') &&
      action.type !== 'gameFlow'
    )
      return index
    state = applyAction(state, action).state
  }
  return actions.length
}

/** A play as an importer stores it: its outcome, without pitches or a record. */
export function asImported(play: GumboPlay): GumboPlay {
  const { about, result, count, matchup, runners, credits } = play
  return JSON.parse(
    JSON.stringify({
      about,
      result: { ...result, description: undefined },
      count: count == null ? undefined : { outs: count.outs },
      matchup,
      runners,
      credits
    })
  ) as GumboPlay
}

/**
 * The first two innings imported from elsewhere, as plays without records,
 * and the third scored in TeamStation from there.
 */
export async function importedThenScoredGame(
  setup = replaySetup()
): Promise<StoredGame> {
  const actions = replayActions(setup)
  const third = firstActionOfHalf(actions, 3, 'top', setup)
  const final = await finalGame(setup)
  const imported = final.plays
    .filter(play => (play.about.inning ?? 0) < 3)
    .map(asImported)
  const store = new MemoryStore()
  for (const play of imported) store.plays.set(play.about.atBatIndex, play)
  return await scored(actions.slice(third), setup, store)
}

/** The game after a timeline's first `count` steps, as a replay shows it. */
export function stateAfterSteps(
  timeline: { start: GameState; steps: Array<{ actions: ScoringAction[] }> },
  count: number
): GameState {
  let state = timeline.start
  for (const step of timeline.steps.slice(0, count))
    for (const action of step.actions) {
      const applied = applyAction(state, action)
      if (applied.problems.length > 0)
        throw new Error(applied.problems[0].message)
      state = applied.state
    }
  return state
}
