import type { ChatPendingLink } from '../../common/api'
import type { GameSocket } from '../../common/gameSocket'
import {
  approveLink,
  type ChatSetup,
  readApprovalKeys,
  reasonOf
} from './engine/links'

export interface ApprovalState {
  links: ChatPendingLink[]
  /** This device can approve: a linked key record was read. */
  ready: boolean
  /** A read for this account has finished, successfully or not. */
  settled: boolean
  busy?: string
  /** The last decision that failed, shown only on that request. */
  error?: string
  errorFor?: string
  /** The last read that failed. A later successful read clears it. */
  readError?: string
  revision: number
  dismissed: ReadonlySet<string>
}

export const EMPTY_APPROVAL_STATE: ApprovalState = {
  links: [],
  ready: false,
  settled: false,
  revision: 0,
  dismissed: new Set()
}

/** One account-owned decision queue for the shell, inbox and device list. */
export class DeviceApprovals {
  private state: ApprovalState = EMPTY_APPROVAL_STATE
  private readonly listeners = new Set<() => void>()
  private active = false
  private lifetime = 0
  private refreshing?: Promise<void>
  /** A refresh arrived while one was already reading. One more read follows it. */
  private followUp = false
  private projection?: string
  private working = false
  private unsubscribe?: () => void
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly setup: ChatSetup,
    private readonly socket?: Pick<GameSocket, 'onChat'>
  ) {}

  snapshot = (): ApprovalState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(patch: Partial<ApprovalState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  start(): void {
    if (this.active) return
    this.active = true
    try {
      this.unsubscribe = this.socket?.onChat(event => {
        if (
          event.type === 'resync' ||
          (event.type === 'chatUser' && event.kind !== 'preferences')
        )
          this.refresh().catch(() => undefined)
      })
    } catch {
      // Polling and foreground refresh still work when a socket cannot open.
    }
    this.refresh().catch(() => undefined)
    this.timer = setInterval(() => {
      this.refresh().catch(() => undefined)
    }, 5000)
  }

  stop(): void {
    this.active = false
    this.lifetime++
    this.followUp = false
    this.refreshing = undefined
    this.projection = undefined
    this.unsubscribe?.()
    clearInterval(this.timer)
    this.publish(EMPTY_APPROVAL_STATE)
  }

  refresh = async (): Promise<void> => {
    if (!this.active) return
    if (this.refreshing != null) {
      this.followUp = true
      await this.refreshing
      return
    }
    const run = (async () => {
      do {
        this.followUp = false
        await this.readOnce()
      } while (this.followUp && this.active)
    })().finally(() => {
      if (this.refreshing === run) this.refreshing = undefined
    })
    this.refreshing = run
    await run
  }

  private async readOnce(): Promise<void> {
    const lifetime = this.lifetime
    const current = (): boolean =>
      this.active &&
      lifetime === this.lifetime &&
      this.setup.current?.() !== false
    try {
      const record = await readApprovalKeys({ ...this.setup, current })
      if (!current()) return
      const own = record?.deviceId
      const links = await this.setup.client.chatLinks()
      if (!current()) return
      // Include our own request: its expiry must refresh Notifications too.
      // Identical polls must not restart slower reads in the inbox or detail.
      const projection = JSON.stringify([own, links])
      const same = projection === this.projection
      if (same && this.state.settled && this.state.readError == null) return
      this.projection = projection
      this.publish({
        ...(same
          ? {}
          : {
              links: links.filter(link => link.newDevice.id !== own),
              revision: this.state.revision + 1
            }),
        ready: own != null,
        settled: true,
        readError: undefined
      })
    } catch (error) {
      if (!current()) return
      this.publish({
        settled: true,
        readError:
          error instanceof Error
            ? error.message
            : 'Chat devices could not be loaded.'
      })
    }
  }

  dismiss(id: string): void {
    const clear = this.state.errorFor === id
    this.publish({
      dismissed: new Set([...this.state.dismissed, id]),
      ...(clear ? { error: undefined, errorFor: undefined } : {})
    })
  }

  decide = async (
    id: string,
    decision: 'approve' | 'decline'
  ): Promise<void> => {
    if (!this.active || this.working) return
    this.working = true
    const lifetime = this.lifetime
    const current = (): boolean =>
      this.active &&
      lifetime === this.lifetime &&
      this.setup.current?.() !== false
    this.publish({ busy: id, error: undefined, errorFor: undefined })
    try {
      const record = await readApprovalKeys({ ...this.setup, current })
      if (!current()) return
      if (record == null)
        throw new Error('Open this request on an approved chat device.')
      const links = await this.setup.client.chatLinks()
      if (!current()) return
      const link = links.find(
        link => link.id === id && link.newDevice.id !== record.deviceId
      )
      if (link == null) return
      if (decision === 'approve') await approveLink(this.setup, record, link)
      else await this.setup.client.declineChatLink(id)
    } catch (error) {
      if (!current()) return
      if (
        !['linkApproved', 'linkDeclined', 'linkExpired'].includes(
          reasonOf(error) ?? ''
        )
      ) {
        this.publish({
          error:
            error instanceof Error
              ? error.message
              : 'That did not work. Try again.',
          errorFor: id
        })
        throw error
      }
    } finally {
      this.working = false
      if (current()) {
        // A read started before the decision cannot be its final refresh.
        await this.refreshing?.catch(() => undefined)
        if (current()) {
          await this.refresh().catch(() => undefined)
          if (current()) this.publish({ busy: undefined })
        }
      }
    }
  }
}
