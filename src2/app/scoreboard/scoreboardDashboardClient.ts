import type { DashboardCommand } from '../../common/scoreboard'
import {
  asScoreboardDashboardMessage,
  type ScoreboardDashboard
} from '../../common/scoreboardEvents'
import {
  openReconnecting,
  type Schedule,
  type SocketConstructor
} from './scoreboardSocket'

/**
 * The override dashboard's socket.
 *
 * It receives the whole dashboard state on open and after every change, and
 * sends the dashboard's commands — the whole overrides object, or a reset —
 * in the order they were made. A command made while the socket is down waits
 * for it to come back. Any close is followed by another try 3 s later,
 * except 4401 (signed out), 4403 (does not run this game) and 4404 (closed),
 * where trying again cannot help.
 */
export const DASHBOARD_STOP = [4401, 4403, 4404] as const

export interface DashboardClient {
  send: (command: DashboardCommand) => void
  close: () => void
}

export function connectDashboard(options: {
  url: string
  onState: (state: ScoreboardDashboard) => void
  /** The server could not use a command; the socket stays open. */
  onError?: (message: string) => void
  /** A reconnect: whatever was in flight on the old socket is gone. */
  onOpen?: () => void
  onStop: (code: number) => void
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
}): DashboardClient {
  const waiting: string[] = []
  const flush = (): void => {
    while (waiting.length > 0 && socket.send(waiting[0])) waiting.shift()
  }
  const socket = openReconnecting({
    url: options.url,
    stopOn: DASHBOARD_STOP,
    WebSocketImpl: options.WebSocketImpl,
    schedule: options.schedule,
    onOpen: () => {
      options.onOpen?.()
      flush()
    },
    onMessage: data => {
      let message: unknown
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (
        typeof message === 'object' &&
        message != null &&
        'error' in message
      ) {
        options.onError?.(String(message.error))
        return
      }
      try {
        const { type, ...state } = asScoreboardDashboardMessage(message)
        options.onState(state)
      } catch {
        // Nothing this dashboard can draw.
      }
    },
    onStop: options.onStop
  })
  return {
    send: command => {
      waiting.push(JSON.stringify(command))
      flush()
    },
    close: socket.close
  }
}
