import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { hashToken, sessionToken } from '../../src/server/auth/tokens'

/** Identify the handset which made the watched game's first confirmed pitch.
 * The peer browser and API observer continue to use the isolated stack. */
function client(req: IncomingMessage): string | undefined {
  const token = sessionToken(req.headers.authorization, req.headers.cookie)
  return token == null ? undefined : hashToken(token)
}

export class ScoringOutage {
  private readonly gates = new Map<
    string,
    {
      caller?: string
      offline: boolean
      failedReads: number
      failedWrites: number
      closedSockets: number
      timer: ReturnType<typeof setTimeout>
    }
  >()

  private readonly sockets = new Map<Duplex, string>()

  status(game: string): {
    identified: boolean
    offline: boolean
    failedReads: number
    failedWrites: number
    closedSockets: number
  } {
    const gate = this.gates.get(game)
    return {
      identified: gate?.caller != null,
      offline: gate?.offline === true,
      failedReads: gate?.failedReads ?? 0,
      failedWrites: gate?.failedWrites ?? 0,
      closedSockets: gate?.closedSockets ?? 0
    }
  }

  release(game: string): void {
    const gate = this.gates.get(game)
    if (gate != null) clearTimeout(gate.timer)
    this.gates.delete(game)
  }

  set(game: string, mode: unknown): void {
    const gate = this.gates.get(game)
    if (mode === 'watch' && gate == null) {
      this.gates.set(game, {
        offline: false,
        failedReads: 0,
        failedWrites: 0,
        closedSockets: 0,
        timer: setTimeout(() => {
          this.release(game)
        }, 300000)
      })
    } else if (mode === 'online' && gate?.caller != null) {
      gate.offline = false
    } else if (mode === 'offline' && gate?.caller != null) {
      gate.offline = true
      for (const [socket, caller] of this.sockets) {
        if (caller === gate.caller) {
          gate.closedSockets++
          socket.destroy()
        }
      }
    } else
      throw new Error(
        'Watch the game before its measured client scores, then request offline'
      )
  }

  /** Called before the separate game-write hold. No successful reply or 5xx is fabricated. */
  request(req: IncomingMessage): boolean {
    const path = new URL(req.url ?? '/', 'http://proxy').pathname
    if (
      !path.startsWith('/api/') ||
      path.startsWith('/api/v1/viewport-observation/')
    )
      return false
    const caller = client(req)
    if (caller == null) return false
    if (req.method === 'POST') {
      const game = /^\/api\/v1\/games\/([\w-]+)\/events$/.exec(path)?.[1]
      const gate = game == null ? undefined : this.gates.get(game)
      if (gate != null) gate.caller ??= caller
    }
    for (const gate of this.gates.values()) {
      if (!gate.offline || gate.caller !== caller) continue
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? ''))
        gate.failedWrites++
      else gate.failedReads++
      req.socket.destroy()
      return true
    }
    return false
  }

  socket(req: IncomingMessage, socket: Duplex): boolean {
    const caller = client(req)
    if (caller == null) return false
    for (const gate of this.gates.values()) {
      if (gate.offline && gate.caller === caller) {
        gate.closedSockets++
        socket.destroy()
        return true
      }
    }
    this.sockets.set(socket, caller)
    socket.once('close', () => this.sockets.delete(socket))
    return false
  }

  close(): void {
    for (const game of this.gates.keys()) this.release(game)
  }
}
