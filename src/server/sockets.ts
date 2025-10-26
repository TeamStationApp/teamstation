import type { Server as HttpServer } from 'http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import {
  asDashboardOverrides,
  asScoreState,
  type AutoStateMessage,
  type DashboardOverrides,
  type OverrideUpdateMessage,
  type ScoreState
} from '../common/types'
import { logger } from './util/utils'

// WebSocket servers for each endpoint
let autoStateWss: WebSocketServer | undefined
let dashboardWss: WebSocketServer | undefined
let scoreboardWss: WebSocketServer | undefined

// Client sets
const autoStateClients = new Set<WebSocket>()
const dashboardClients = new Set<WebSocket>()
const scoreboardClients = new Set<WebSocket>()

// State management
let currentAutoState: ScoreState | null = null
let currentDashboardOverrides: DashboardOverrides = {
  overrideCountEnabled: false,
  overrideBasesEnabled: false,
  overrideCount: undefined,
  overrideBases: undefined
}

/**
 * Merge autoState with dashboard overrides to create final scoreboard state
 */
function mergeFinalState(): ScoreState | null {
  if (currentAutoState == null) {
    return null
  }

  const finalState: ScoreState = { ...currentAutoState }

  // Apply count overrides if enabled and present
  if (
    currentDashboardOverrides.overrideCountEnabled &&
    currentDashboardOverrides.overrideCount != null
  ) {
    finalState.balls = currentDashboardOverrides.overrideCount.balls
    finalState.strikes = currentDashboardOverrides.overrideCount.strikes
    finalState.outs = currentDashboardOverrides.overrideCount.outs
  }

  // Apply bases overrides if enabled and present
  if (
    currentDashboardOverrides.overrideBasesEnabled &&
    currentDashboardOverrides.overrideBases != null
  ) {
    finalState.base1 = currentDashboardOverrides.overrideBases.base1
    finalState.base2 = currentDashboardOverrides.overrideBases.base2
    finalState.base3 = currentDashboardOverrides.overrideBases.base3
  }

  return finalState
}

/**
 * Broadcast autoState to dashboard clients
 */
function broadcastToDashboard(scoreState: ScoreState): void {
  if (dashboardClients.size === 0) {
    return
  }

  const message: AutoStateMessage = {
    type: 'autoState',
    data: scoreState
  }
  const messageStr = JSON.stringify(message)
  logger(
    `Broadcasting autoState to ${dashboardClients.size} dashboard client(s)`
  )

  for (const client of Array.from(dashboardClients)) {
    if (client.readyState === 1) {
      try {
        client.send(messageStr)
      } catch (error) {
        console.error('Error sending to dashboard client:', error)
        dashboardClients.delete(client)
      }
    }
  }
}

/**
 * Broadcast override updates to all dashboard clients except the sender
 */
function broadcastOverridesToDashboards(
  overrides: DashboardOverrides,
  excludeClient?: WebSocket
): void {
  if (dashboardClients.size === 0) {
    return
  }

  const message: OverrideUpdateMessage = {
    type: 'overrideUpdate',
    data: overrides
  }
  const messageStr = JSON.stringify(message)
  const targetClients = Array.from(dashboardClients).filter(
    c => c !== excludeClient
  )
  logger(
    `Broadcasting overrides to ${targetClients.length} dashboard client(s)`
  )

  for (const client of targetClients) {
    if (client.readyState === 1) {
      try {
        client.send(messageStr)
      } catch (error) {
        console.error('Error sending override to dashboard client:', error)
        dashboardClients.delete(client)
      }
    }
  }
}

/**
 * Broadcast final merged state to scoreboard clients
 */
function broadcastToScoreboard(scoreState: ScoreState): void {
  if (scoreboardClients.size === 0) {
    return
  }

  const message = JSON.stringify(scoreState)
  logger(
    `Broadcasting final state to ${scoreboardClients.size} scoreboard client(s)`
  )

  for (const client of Array.from(scoreboardClients)) {
    if (client.readyState === 1) {
      try {
        client.send(message)
      } catch (error) {
        console.error('Error sending to scoreboard client:', error)
        scoreboardClients.delete(client)
      }
    }
  }
}

export function initializeWebSocketServer(server: HttpServer): void {
  // 1. AutoState endpoint - receives updates from checkGameAndroidLoop
  autoStateWss = new WebSocketServer({
    noServer: true
  })

  autoStateWss.on('connection', (ws: WebSocket) => {
    logger('New autoState client connected (engine)')
    autoStateClients.add(ws)

    // Handle incoming autoState updates from engine
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString()
        const rawData = JSON.parse(message)
        const scoreState: ScoreState = asScoreState(rawData)
        logger('Received autoState update from engine')

        // Store current autoState
        currentAutoState = scoreState

        // Broadcast to dashboard
        broadcastToDashboard(scoreState)

        // Merge and broadcast to scoreboard
        const finalState = mergeFinalState()
        if (finalState != null) {
          broadcastToScoreboard(finalState)
        }
      } catch (error) {
        console.error('Error parsing or validating autoState message:', error)
      }
    })

    ws.on('close', () => {
      logger('AutoState client disconnected')
      autoStateClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('AutoState WebSocket error:', error)
      autoStateClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/autoState')

  // 2. Dashboard endpoint - sends autoState updates, receives override updates
  dashboardWss = new WebSocketServer({
    noServer: true
  })

  dashboardWss.on('connection', (ws: WebSocket) => {
    logger('New dashboard client connected')
    dashboardClients.add(ws)

    // Send current autoState to new dashboard client
    if (currentAutoState != null) {
      const autoMessage: AutoStateMessage = {
        type: 'autoState',
        data: currentAutoState
      }
      ws.send(JSON.stringify(autoMessage))
    }

    // Send current override state to new dashboard client
    const overrideMessage: OverrideUpdateMessage = {
      type: 'overrideUpdate',
      data: currentDashboardOverrides
    }
    ws.send(JSON.stringify(overrideMessage))

    // Handle incoming override updates from dashboard
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString()
        const rawData = JSON.parse(message)
        const overrides: DashboardOverrides = asDashboardOverrides(rawData)
        logger('Received dashboard override update')

        // Update current overrides
        currentDashboardOverrides = overrides

        // Broadcast override update to all OTHER dashboard clients (not the sender)
        broadcastOverridesToDashboards(overrides, ws)

        // Merge and broadcast to scoreboard
        const finalState = mergeFinalState()
        if (finalState != null) {
          broadcastToScoreboard(finalState)
        }
      } catch (error) {
        console.error(
          'Error parsing or validating dashboard override message:',
          error
        )
      }
    })

    ws.on('close', () => {
      logger('Dashboard client disconnected')
      dashboardClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('Dashboard WebSocket error:', error)
      dashboardClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/dashboard')

  // 3. Scoreboard endpoint - receives final merged state
  scoreboardWss = new WebSocketServer({
    noServer: true
  })

  scoreboardWss.on('connection', (ws: WebSocket) => {
    logger('New scoreboard client connected')
    scoreboardClients.add(ws)

    // Send current final state to new scoreboard client
    const finalState = mergeFinalState()
    if (finalState != null) {
      ws.send(JSON.stringify(finalState))
    }

    ws.on('close', () => {
      logger('Scoreboard client disconnected')
      scoreboardClients.delete(ws)
    })

    ws.on('error', error => {
      console.error('Scoreboard WebSocket error:', error)
      scoreboardClients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/scoreboard')

  // Handle upgrade requests manually
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url

    if (pathname === '/sockets/api/v1/autoState') {
      autoStateWss?.handleUpgrade(request, socket, head, ws => {
        autoStateWss?.emit('connection', ws, request)
      })
    } else if (pathname === '/sockets/api/v1/dashboard') {
      dashboardWss?.handleUpgrade(request, socket, head, ws => {
        dashboardWss?.emit('connection', ws, request)
      })
    } else if (pathname === '/sockets/api/v1/scoreboard') {
      scoreboardWss?.handleUpgrade(request, socket, head, ws => {
        scoreboardWss?.emit('connection', ws, request)
      })
    } else {
      socket.destroy()
    }
  })
}

// Keep old function for backward compatibility, but it's no longer used
export function broadcastScoreState(scoreState: ScoreState): void {
  // Deprecated - now handled internally
  logger('Warning: broadcastScoreState is deprecated')
}
