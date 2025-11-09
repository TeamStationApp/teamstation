import {
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'

// WebSocket configuration
export const WS_RECONNECT_WAIT_MS = 3000

// ScoreState - shared between client and server
export const asScoreState = asObject({
  inGame: asBoolean,
  pitcherName: asString,
  batterName: asString,
  batterNumber: asNumber,
  batterNumHits: asNumber,
  batterAtBats: asNumber,
  numPitches: asNumber,
  balls: asNumber,
  strikes: asNumber,
  outs: asNumber,
  base1: asBoolean,
  base2: asBoolean,
  base3: asBoolean,
  inning: asNumber,
  half: asValue('top', 'bottom', 'mid'),
  homeTeam: asString,
  awayTeam: asString,
  homeScore: asNumber,
  awayScore: asNumber
})

export type ScoreState = ReturnType<typeof asScoreState>

// Dashboard overrides - shared between client and server
export const asDashboardOverrides = asObject({
  overrideCountEnabled: asBoolean,
  overrideBasesEnabled: asBoolean,
  overrideTeamEnabled: asBoolean,
  overrideScoreEnabled: asBoolean,
  overrideInningEnabled: asBoolean,
  overrideCount: asOptional(
    asObject({
      balls: asNumber,
      strikes: asNumber,
      outs: asNumber
    })
  ),
  overrideBases: asOptional(
    asObject({
      base1: asBoolean,
      base2: asBoolean,
      base3: asBoolean
    })
  ),
  overrideTeam: asOptional(
    asObject({
      homeTeam: asString,
      awayTeam: asString
    })
  ),
  overrideScore: asOptional(
    asObject({
      homeScore: asNumber,
      awayScore: asNumber
    })
  ),
  overrideInning: asOptional(
    asObject({
      inning: asNumber,
      half: asValue('top', 'bottom', 'mid')
    })
  )
})

export type DashboardOverrides = ReturnType<typeof asDashboardOverrides>

// WebSocket message types for Dashboard endpoint
export const asAutoStateMessage = asObject({
  type: asValue('autoState'),
  data: asScoreState
})

export type AutoStateMessage = ReturnType<typeof asAutoStateMessage>

export const asOverrideUpdateMessage = asObject({
  type: asValue('overrideUpdate'),
  data: asDashboardOverrides
})

export type OverrideUpdateMessage = ReturnType<typeof asOverrideUpdateMessage>

export const asDashboardMessage = asObject({
  type: asValue('autoState', 'overrideUpdate')
})

export type DashboardMessage = AutoStateMessage | OverrideUpdateMessage
