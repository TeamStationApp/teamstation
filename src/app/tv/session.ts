import {
  asSession,
  type Session,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { TvLoginRequest } from '../../common/tvLogin'

export interface TvSessionStore {
  load: () => Promise<string | null>
  save: (value: string) => Promise<void>
  clear: () => Promise<void>
}
export interface TvSessionState {
  phase: 'loading' | 'login' | 'ready' | 'error'
  request?: TvLoginRequest
  session?: Session
  error?: string
}
/** Owns request rotation and polling; a stale response cannot sign in a new visit. */
export class TvSessionController {
  private state: TvSessionState = { phase: 'loading' }
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    readonly client: TeamStationClient,
    private readonly store: TvSessionStore,
    private readonly origin: string
  ) {}

  snapshot = (): TvSessionState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(state: TvSessionState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  stop(): void {
    this.epoch++
    clearTimeout(this.timer)
  }

  async boot(): Promise<void> {
    this.stop()
    const epoch = this.epoch
    this.publish({ phase: 'loading' })
    try {
      const value = await this.store.load()
      if (epoch !== this.epoch) return
      let saved: Session | undefined
      if (value != null) {
        try {
          const parsed = JSON.parse(value) as {
            origin?: unknown
            session?: unknown
          }
          if (parsed.origin === this.origin) saved = asSession(parsed.session)
        } catch {
          await this.store.clear()
        }
      }
      if (epoch !== this.epoch) return
      if (saved != null) {
        this.client.token = saved.token
        this.publish({ phase: 'loading', session: saved })
        const user = await this.client.whoAmI()
        if (epoch !== this.epoch) return
        if (user != null) {
          this.publish({ phase: 'ready', session: { ...saved, user } })
          return
        }
        await this.store.clear()
      }
      this.client.token = undefined
      if (epoch === this.epoch) await this.renew()
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    }
  }

  private fail(error: unknown): void {
    this.publish({
      ...this.state,
      phase: 'error',
      error:
        error instanceof Error ? error.message : 'Unable to connect. Try again.'
    })
  }

  async renew(): Promise<void> {
    this.stop()
    const epoch = this.epoch
    this.publish({ phase: 'loading' })
    try {
      const request = await this.client.startTvLogin('Apple TV')
      if (epoch !== this.epoch) return
      this.publish({ phase: 'login', request })
      this.schedule(epoch)
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    }
  }

  private schedule(epoch: number): void {
    const request = this.state.request
    if (request == null) return
    this.timer = setTimeout(
      () => {
        this.poll(epoch).catch((error: unknown) => {
          if (epoch === this.epoch) this.fail(error)
        })
      },
      Math.max(0, Math.min(3000, request.expiresAt - Date.now()))
    )
  }

  async poll(epoch = this.epoch): Promise<void> {
    clearTimeout(this.timer)
    const request = this.state.request
    if (request == null || epoch !== this.epoch) return
    if (request.expiresAt <= Date.now()) {
      await this.renew()
      return
    }
    try {
      const result = await this.client.claimTvLogin(
        request.requestId,
        request.clientSecret
      )
      if (epoch !== this.epoch) return
      if ('token' in result) {
        await this.store.save(
          JSON.stringify({ origin: this.origin, session: result })
        )
        if (epoch !== this.epoch) return
        this.client.token = result.token
        this.publish({ phase: 'ready', session: result })
      } else this.schedule(epoch)
    } catch (error) {
      if (epoch !== this.epoch) return
      if (error instanceof HttpError && error.code === 'unauthorized')
        await this.renew()
      else this.fail(error)
    }
  }

  async signOut(): Promise<void> {
    this.stop()
    const epoch = this.epoch
    try {
      await this.client.signOut()
      await this.store.clear()
      if (epoch === this.epoch) await this.renew()
    } catch (error) {
      if (epoch === this.epoch) this.fail(error)
    }
  }
}
