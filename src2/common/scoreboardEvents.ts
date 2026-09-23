import { asArray, asNumber, asObject, asOptional, asValue } from 'cleaners'

import { asDirectorEvent } from './api'
import { asDashboardOverrides, asScoreboardState } from './scoreboard'

/**
 * The scoreboard API's answers.
 *
 * The games a scoreboard may be published to: those that started in the
 * last three hours and whose board is still open, newest first, and the next
 * five, soonest first. Each is the same row GS Director's picker lists.
 */
export const asScoreboardEvents = asObject({
  recent: asArray(asDirectorEvent),
  upcoming: asArray(asDirectorEvent)
})
export type ScoreboardEvents = ReturnType<typeof asScoreboardEvents>

/** What anybody sees: the board as it is drawn. */
export const asScoreboardView = asObject({ state: asScoreboardState })
export type ScoreboardView = ReturnType<typeof asScoreboardView>

/**
 * What the override dashboard sees: the automated board, the overrides, the
 * board they make, and when (milliseconds) each automated source last
 * reported a contested field.
 */
export const asScoreboardDashboard = asObject({
  automated: asScoreboardState,
  overrides: asDashboardOverrides,
  final: asScoreboardState,
  gameAt: asOptional(asNumber),
  watcherAt: asOptional(asNumber)
})
export type ScoreboardDashboard = ReturnType<typeof asScoreboardDashboard>

/** The same, as the dashboard socket sends it on open and on every change. */
export const asScoreboardDashboardMessage = asObject({
  ...asScoreboardDashboard.shape,
  type: asValue('state' as const)
})
