import type {
  DictationSocket,
  OpenMicrophone
} from '../app/scoring/dictationTypes'
import type { Health } from '../common/api'

/**
 * Stand-ins for dictation's socket and microphone in unit tests: the socket
 * keeps what it is sent, and a test opens it and plays the server's replies;
 * the microphone counts its opens and stops.
 */
export class FakeDictationSocket implements DictationSocket {
  readyState = 0
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  reply(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  get frames(): Array<Record<string, any>> {
    return this.sent
      .filter((f): f is string => typeof f === 'string')
      .map(f => JSON.parse(f) as Record<string, any>)
  }

  get audio(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => f instanceof ArrayBuffer)
  }
}

export interface FakeDictation {
  sockets: FakeDictationSocket[]
  socket: () => FakeDictationSocket
  microphone: { opened: number; stopped: number }
  openSocket: (url: string) => DictationSocket
  openMicrophone: OpenMicrophone
}

export function fakeDictation(): FakeDictation {
  const sockets: FakeDictationSocket[] = []
  const microphone = { opened: 0, stopped: 0 }
  return {
    sockets,
    socket: () => sockets[sockets.length - 1],
    microphone,
    openSocket: url => {
      const socket = new FakeDictationSocket(url)
      sockets.push(socket)
      return socket
    },
    openMicrophone: async () => {
      microphone.opened++
      return {
        stop: () => {
          microphone.stopped++
        }
      }
    }
  }
}

/** A server that dictates, with the default model on offer. */
export const dictatingHealth = async (): Promise<Health> => ({
  status: 'ok',
  version: '1',
  database: 'ok',
  migrations: 1,
  dictation: true,
  dictationModels: ['claude-haiku-5-5']
})
