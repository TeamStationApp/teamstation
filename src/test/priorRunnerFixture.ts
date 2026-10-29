import { memoryStore } from '../app/scoring/scoringSource'
import { asGameDetail, asRosterEntry, type RosterEntry } from '../common/api'
import type { ScoringAction } from '../common/scoring/actions'
import { freshGame, newSetup } from '../common/scoring/rules'
import { ScoringSession } from '../common/scoring/session'
import { POSITIONS } from '../common/scoring/state'
import { userIdOfGumbo } from '../common/userId'

export const priorRunnerGame = asGameDetail({
  nonMemberView: false,
  id: 'prior-runner',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  videos: []
})
const names = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt'
]
export const priorRunnerRoster = (side: string): RosterEntry[] =>
  names.map((displayName, i) =>
    asRosterEntry({
      userId: userIdOfGumbo((side === 'away' ? 100 : 200) + i),
      gumboId: (side === 'away' ? 100 : 200) + i,
      displayName,
      shortName: displayName,
      jersey: String(i + 1),
      positions: [POSITIONS[i]],
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      bats: 'right',
      throws: 'right'
    })
  )

export type PriorRunnerScenario =
  'first' | 'second' | 'home' | 'pitched' | 'open' | 'occupied' | 'timed'
export function priorRunnerFixture(scenario: PriorRunnerScenario): {
  session: ScoringSession
  store: ReturnType<typeof memoryStore>
} {
  const teams = {
    away: { id: 'away', name: 'Owls' },
    home: { id: 'home', name: 'Hawks' }
  }
  const setup = newSetup(teams, {
    away: priorRunnerRoster('away'),
    home: priorRunnerRoster('home')
  })
  const opening = freshGame(priorRunnerGame.id, teams, setup)
  for (const player of Object.values(opening.gameData.players))
    player.local = true
  const store = memoryStore()
  let tick = 0
  const session = ScoringSession.start(store, priorRunnerGame.id, opening, {
    now: () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++)),
    setTimer: () => null,
    clearTimer: () => undefined
  })
  const hit: ScoringAction[] = [
    { type: 'ballInPlay', contact: 'swing', fielder: 207 },
    { type: 'result', eventType: 'single' }
  ]
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const actions: ScoringAction[] = [...hit]
  if (scenario === 'timed') {
    actions[1] = { type: 'result', eventType: 'double' }
    actions.push(close)
  } else if (scenario === 'first' || scenario === 'pitched') {
    actions.push({ type: 'runnerMovement', runner: 100, to: '2B' }, close)
  } else {
    actions.push(close)
    if (scenario !== 'occupied')
      actions.push({ type: 'baseRunning', kind: 'steal', runner: 100 })
    if (scenario === 'home')
      actions.push({ type: 'baseRunning', kind: 'steal', runner: 100 })
    actions.push(...hit)
    if (scenario === 'home')
      actions.push({ type: 'runnerMovement', runner: 100, to: 'home' })
    if (scenario !== 'open') actions.push(close)
  }
  if (scenario === 'pitched')
    actions.push(
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'B' }
    )
  for (const action of actions) {
    const result = session.apply(action)
    if (result.problems.length > 0)
      throw new Error(JSON.stringify(result.problems))
  }
  return { session, store }
}
