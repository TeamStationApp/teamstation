import type { Server as HttpServer } from 'http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import {
  asDashboardOverrides,
  asScoreStateUpdate,
  type AutoStateMessage,
  type DashboardOverrides,
  type OverrideUpdateMessage,
  type ScoreState,
  type ScoreStateUpdate,
  type SplitStatusMessage
} from '../common/types'
import {
  subscribeStatus as subscribeSplitStatus,
  unsubscribeStatus as unsubscribeSplitStatus
} from './rtmp/splitter'
import { logger } from './util/utils'

// WebSocket servers for each endpoint
let autoStateWss: WebSocketServer | undefined
let dashboardWss: WebSocketServer | undefined
let scoreboardWss: WebSocketServer | undefined
let splitWss: WebSocketServer | undefined

// Event state management - one per eventId
interface EventState {
  autoState: ScoreState
  dashboardOverrides: DashboardOverrides
  autoStateClients: Set<WebSocket>
  dashboardClients: Set<WebSocket>
  scoreboardClients: Set<WebSocket>
}

// Map of eventId to EventState
const eventStates = new Map<string, EventState>()

function createDefaultAutoState(): ScoreState {
  return {
    inGame: false,
    pitcherName: '',
    batterName: '',
    batterNumber: 0,
    batterNumHits: 0,
    batterAtBats: 0,
    numPitches: 0,
    balls: 0,
    strikes: 0,
    outs: 0,
    base1: false,
    base2: false,
    base3: false,
    inning: 0,
    half: 'top',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    homeScore: 0,
    awayScore: 0,
    pitchSpeed: 0
  }
}

/**
 * Merge a partial ScoreStateUpdate into an existing ScoreState. Only fields
 * present (not undefined) in the update override the corresponding fields.
 * This is the shared write path for every engine that sends an update, each
 * of which may contribute its own subset of ScoreState (a Tag One reader
 * sends just `pitchSpeed`).
 */
function mergeScoreStateUpdate(
  current: ScoreState,
  update: ScoreStateUpdate
): ScoreState {
  const next: ScoreState = { ...current }
  for (const key of Object.keys(update) as Array<keyof ScoreStateUpdate>) {
    const value = update[key]
    if (value === undefined) continue
    ;(next as any)[key] = value
  }
  return next
}

function createDefaultDashboardOverrides(): DashboardOverrides {
  return {
    overrideCountEnabled: false,
    overrideBasesEnabled: false,
    overrideTeamEnabled: false,
    overrideScoreEnabled: false,
    overrideInningEnabled: false,
    overrideCount: undefined,
    overrideBases: undefined,
    overrideTeam: undefined,
    overrideScore: undefined,
    overrideInning: undefined
  }
}

/**
 * Get or create event state for a given eventId
 */
function getOrCreateEventState(eventId: string): EventState {
  let state = eventStates.get(eventId)
  if (state == null) {
    state = {
      autoState: createDefaultAutoState(),
      dashboardOverrides: createDefaultDashboardOverrides(),
      autoStateClients: new Set<WebSocket>(),
      dashboardClients: new Set<WebSocket>(),
      scoreboardClients: new Set<WebSocket>()
    }
    eventStates.set(eventId, state)
    logger(`Created new event state for eventId: ${eventId}`)
  }
  return state
}

/**
 * Reset in-memory game state for a given eventId only.
 * Other sessions are unaffected. Connected clients remain connected and
 * receive broadcasts so they immediately reflect cleared state.
 */
function resetEventState(eventId: string): void {
  const state = eventStates.get(eventId)
  if (state == null) {
    logger(`Reset requested for unknown eventId: ${eventId}`)
    return
  }

  state.autoState = createDefaultAutoState()
  state.dashboardOverrides = createDefaultDashboardOverrides()
  logger(`Reset in-memory game state for event: ${eventId}`)

  broadcastToDashboard(eventId, state.autoState)
  broadcastOverridesToDashboards(eventId, state.dashboardOverrides)
  const finalState = mergeFinalState(eventId)
  if (finalState != null) {
    broadcastToScoreboard(eventId, finalState)
  }
}

/**
 * Merge autoState with dashboard overrides to create final scoreboard state
 */
function mergeFinalState(eventId: string): ScoreState | null {
  const state = eventStates.get(eventId)
  if (state?.autoState == null) {
    return null
  }

  const finalState: ScoreState = { ...state.autoState }
  const overrides = state.dashboardOverrides

  // Apply count overrides if enabled and present
  if (overrides.overrideCountEnabled && overrides.overrideCount != null) {
    finalState.balls = overrides.overrideCount.balls
    finalState.strikes = overrides.overrideCount.strikes
    finalState.outs = overrides.overrideCount.outs
  }

  // Apply bases overrides if enabled and present
  if (overrides.overrideBasesEnabled && overrides.overrideBases != null) {
    finalState.base1 = overrides.overrideBases.base1
    finalState.base2 = overrides.overrideBases.base2
    finalState.base3 = overrides.overrideBases.base3
  }

  // Apply team overrides if enabled and present
  if (overrides.overrideTeamEnabled && overrides.overrideTeam != null) {
    finalState.homeTeam = overrides.overrideTeam.homeTeam
    finalState.awayTeam = overrides.overrideTeam.awayTeam
  }

  // Apply score overrides if enabled and present
  if (overrides.overrideScoreEnabled && overrides.overrideScore != null) {
    finalState.homeScore = overrides.overrideScore.homeScore
    finalState.awayScore = overrides.overrideScore.awayScore
  }

  // Apply inning overrides if enabled and present
  if (overrides.overrideInningEnabled && overrides.overrideInning != null) {
    finalState.inning = overrides.overrideInning.inning
    finalState.half = overrides.overrideInning.half
  }

  return finalState
}

/**
 * Broadcast autoState to dashboard clients for a specific event
 */
function broadcastToDashboard(eventId: string, scoreState: ScoreState): void {
  const state = eventStates.get(eventId)
  if (state == null || state.dashboardClients.size === 0) {
    return
  }

  const message: AutoStateMessage = {
    type: 'autoState',
    data: scoreState
  }
  const messageStr = JSON.stringify(message)
  logger(
    `Broadcasting autoState to ${state.dashboardClients.size} dashboard client(s) for event ${eventId}`
  )

  for (const client of Array.from(state.dashboardClients)) {
    if (client.readyState === 1) {
      try {
        client.send(messageStr)
      } catch (error) {
        console.error('Error sending to dashboard client:', error)
        state.dashboardClients.delete(client)
      }
    }
  }
}

/**
 * Broadcast override updates to all dashboard clients except the sender for a specific event
 */
function broadcastOverridesToDashboards(
  eventId: string,
  overrides: DashboardOverrides,
  excludeClient?: WebSocket
): void {
  const state = eventStates.get(eventId)
  if (state == null || state.dashboardClients.size === 0) {
    return
  }

  const message: OverrideUpdateMessage = {
    type: 'overrideUpdate',
    data: overrides
  }
  const messageStr = JSON.stringify(message)
  const targetClients = Array.from(state.dashboardClients).filter(
    c => c !== excludeClient
  )
  logger(
    `Broadcasting overrides to ${targetClients.length} dashboard client(s) for event ${eventId}`
  )

  for (const client of targetClients) {
    if (client.readyState === 1) {
      try {
        client.send(messageStr)
      } catch (error) {
        console.error('Error sending override to dashboard client:', error)
        state.dashboardClients.delete(client)
      }
    }
  }
}

/**
 * Broadcast final merged state to scoreboard clients for a specific event
 */
function broadcastToScoreboard(eventId: string, scoreState: ScoreState): void {
  const state = eventStates.get(eventId)
  if (state == null || state.scoreboardClients.size === 0) {
    return
  }

  const message = JSON.stringify(scoreState)
  logger(
    `Broadcasting final state to ${state.scoreboardClients.size} scoreboard client(s) for event ${eventId}`
  )

  for (const client of Array.from(state.scoreboardClients)) {
    if (client.readyState === 1) {
      try {
        client.send(message)
      } catch (error) {
        console.error('Error sending to scoreboard client:', error)
        state.scoreboardClients.delete(client)
      }
    }
  }
}

/**
 * Extract eventId from WebSocket URL path
 */
function extractEventId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null
  }
  const eventId = pathname.slice(prefix.length)
  if (eventId === '' || eventId === '/') {
    return null
  }
  // Remove leading slash if present
  return eventId.startsWith('/') ? eventId.slice(1) : eventId
}

export function initializeWebSocketServer(server: HttpServer): void {
  // 1. AutoState endpoint - receives updates from checkGameAndroidLoop
  autoStateWss = new WebSocketServer({
    noServer: true
  })

  autoStateWss.on('connection', (ws: WebSocket, eventId: string) => {
    logger(`New autoState client connected for event: ${eventId}`)
    const state = getOrCreateEventState(eventId)
    state.autoStateClients.add(ws)

    // Handle incoming autoState updates from engine
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString()
        const rawData = JSON.parse(message)
        const update: ScoreStateUpdate = asScoreStateUpdate(rawData)
        logger(`Received autoState update from engine for event: ${eventId}`)

        // Merge partial update into canonical autoState for this event so
        // disjoint engines can each contribute their own slice without
        // clobbering each other's fields.
        state.autoState = mergeScoreStateUpdate(state.autoState, update)

        // Broadcast the merged canonical state to dashboard clients.
        broadcastToDashboard(eventId, state.autoState)

        // Merge and broadcast to scoreboard for this event
        const finalState = mergeFinalState(eventId)
        if (finalState != null) {
          broadcastToScoreboard(eventId, finalState)
        }
      } catch (error) {
        console.error('Error parsing or validating autoState message:', error)
      }
    })

    ws.on('close', () => {
      logger(`AutoState client disconnected for event: ${eventId}`)
      state.autoStateClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('AutoState WebSocket error:', error)
      state.autoStateClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/autoState/{eventId}')

  // 2. Dashboard endpoint - sends autoState updates, receives override updates
  dashboardWss = new WebSocketServer({
    noServer: true
  })

  dashboardWss.on('connection', (ws: WebSocket, eventId: string) => {
    logger(`New dashboard client connected for event: ${eventId}`)
    const state = getOrCreateEventState(eventId)
    state.dashboardClients.add(ws)

    // Send current autoState to new dashboard client
    if (state.autoState != null) {
      const autoMessage: AutoStateMessage = {
        type: 'autoState',
        data: state.autoState
      }
      ws.send(JSON.stringify(autoMessage))
    }

    // Send current override state to new dashboard client
    const overrideMessage: OverrideUpdateMessage = {
      type: 'overrideUpdate',
      data: state.dashboardOverrides
    }
    ws.send(JSON.stringify(overrideMessage))

    // Handle incoming override updates from dashboard
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString()
        const rawData = JSON.parse(message)

        if (rawData?.type === 'reset') {
          logger(`Received dashboard reset request for event: ${eventId}`)
          resetEventState(eventId)
          return
        }

        const overrides: DashboardOverrides = asDashboardOverrides(rawData)
        logger(`Received dashboard override update for event: ${eventId}`)

        // Update current overrides for this event
        state.dashboardOverrides = overrides

        // Broadcast override update to all OTHER dashboard clients (not the sender)
        broadcastOverridesToDashboards(eventId, overrides, ws)

        // Merge and broadcast to scoreboard for this event
        const finalState = mergeFinalState(eventId)
        if (finalState != null) {
          broadcastToScoreboard(eventId, finalState)
        }
      } catch (error) {
        console.error(
          'Error parsing or validating dashboard override message:',
          error
        )
      }
    })

    ws.on('close', () => {
      logger(`Dashboard client disconnected for event: ${eventId}`)
      state.dashboardClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('Dashboard WebSocket error:', error)
      state.dashboardClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/dashboard/{eventId}')

  // 3. Scoreboard endpoint - receives final merged state
  scoreboardWss = new WebSocketServer({
    noServer: true
  })

  scoreboardWss.on('connection', (ws: WebSocket, eventId: string) => {
    logger(`New scoreboard client connected for event: ${eventId}`)
    const state = getOrCreateEventState(eventId)
    state.scoreboardClients.add(ws)

    // Send current final state to new scoreboard client
    const finalState = mergeFinalState(eventId)
    if (finalState != null) {
      ws.send(JSON.stringify(finalState))
    }

    ws.on('close', () => {
      logger(`Scoreboard client disconnected for event: ${eventId}`)
      state.scoreboardClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('Scoreboard WebSocket error:', error)
      state.scoreboardClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/scoreboard/{eventId}')

  // 4. Split status endpoint - pushes RTMP splitter ingress/outbound status
  splitWss = new WebSocketServer({
    noServer: true
  })

  splitWss.on('connection', (ws: WebSocket, eventId: string) => {
    logger(`New split status client connected for event: ${eventId}`)
    const snapshot = subscribeSplitStatus(eventId, ws)
    const initial: SplitStatusMessage = {
      type: 'splitStatus',
      data: snapshot
    }
    try {
      ws.send(JSON.stringify(initial))
    } catch (error) {
      logger('Error sending initial split status:', error)
    }

    ws.on('close', () => {
      logger(`Split status client disconnected for event: ${eventId}`)
      unsubscribeSplitStatus(eventId, ws)
    })

    ws.on('error', error => {
      console.error('Split status WebSocket error:', error)
      unsubscribeSplitStatus(eventId, ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/split/{eventId}')

  // Handle upgrade requests manually
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url ?? ''

    // Extract eventId from each endpoint type
    let eventId: string | null = null
    let targetWss: WebSocketServer | undefined

    if (pathname.startsWith('/sockets/api/v1/autoState/')) {
      eventId = extractEventId(pathname, '/sockets/api/v1/autoState/')
      targetWss = autoStateWss
    } else if (pathname.startsWith('/sockets/api/v1/dashboard/')) {
      eventId = extractEventId(pathname, '/sockets/api/v1/dashboard/')
      targetWss = dashboardWss
    } else if (pathname.startsWith('/sockets/api/v1/scoreboard/')) {
      eventId = extractEventId(pathname, '/sockets/api/v1/scoreboard/')
      targetWss = scoreboardWss
    } else if (pathname.startsWith('/sockets/api/v1/split/')) {
      eventId = extractEventId(pathname, '/sockets/api/v1/split/')
      targetWss = splitWss
    } else {
      logger(`Invalid WebSocket path: ${pathname}`)
      socket.destroy()
      return
    }

    if (eventId == null || eventId === '') {
      logger(`No eventId found in path: ${pathname}`)
      socket.destroy()
      return
    }

    if (targetWss == null) {
      logger(`No WebSocket server found for path: ${pathname}`)
      socket.destroy()
      return
    }

    // Upgrade the connection and pass the eventId
    targetWss.handleUpgrade(request, socket, head, ws => {
      targetWss?.emit('connection', ws, eventId)
    })
  })
}

// Keep old function for backward compatibility, but it's no longer used
export function broadcastScoreState(scoreState: ScoreState): void {
  // Deprecated - now handled internally per event
  logger('Warning: broadcastScoreState is deprecated')
}
