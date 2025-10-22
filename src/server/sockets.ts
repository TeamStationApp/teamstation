import type { Server as HttpServer } from 'http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import type { ScoreState } from './types/types'
import { logger } from './util/utils'

let wss: WebSocketServer | undefined
const clients = new Set<WebSocket>()

export function initializeWebSocketServer(server: HttpServer): void {
  wss = new WebSocketServer({
    server,
    path: '/sockets/api/v1/scoreState'
  })

  wss.on('connection', (ws: WebSocket) => {
    logger('New WebSocket client connected')
    clients.add(ws)

    // Handle incoming messages from clients (e.g., the scanner process)
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString()
        const scoreState: ScoreState = JSON.parse(message)
        logger('Received score state update, broadcasting to all clients')

        // Broadcast to all other clients
        broadcastScoreState(scoreState)
      } catch (error) {
        console.error('Error parsing incoming message:', error)
      }
    })

    ws.on('close', () => {
      logger('WebSocket client disconnected')
      clients.delete(ws)
    })

    ws.on('error', error => {
      console.error('WebSocket error:', error)
      clients.delete(ws)
    })
  })

  logger('WebSocket server initialized at /sockets/api/v1/scoreState')
}

export function broadcastScoreState(scoreState: ScoreState): void {
  if (clients.size === 0) {
    return
  }

  const message = JSON.stringify(scoreState)
  logger(`Broadcasting scoreState to ${clients.size} client(s)`)

  for (const client of Array.from(clients)) {
    if (client.readyState === 1) {
      // 1 = OPEN
      try {
        client.send(message)
      } catch (error) {
        console.error('Error sending to client:', error)
        clients.delete(client)
      }
    }
  }
}
