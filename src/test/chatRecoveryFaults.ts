/** Scoped, disposable-fixture faults. No application or shared proxy uses this. */
import assert from 'node:assert/strict'

export interface RecoveryFault {
  gateId: string
  userId: string
  conversationId: string
  kind: 'send' | 'page' | 'history' | 'epoch'
  outcome: 'success' | 'failure' | 'empty'
  delayMs: number
  remaining: number
}

export interface FaultAudit {
  gateId: string
  remaining: number
  event?: 'delay-released' | 'cleared'
}

/** Claims are synchronous, so concurrent requests cannot consume one gate twice. */
export class RecoveryFaults {
  private readonly gates = new Map<string, RecoveryFault>()
  private readonly releases = new Map<string, Set<() => void>>()

  constructor(private readonly audit: (row: FaultAudit) => void) {}

  set(fault: RecoveryFault): void {
    assert(/^[a-zA-Z0-9_-]{1,120}$/.test(fault.gateId))
    assert(fault.userId.startsWith('usr_'))
    assert(/^cnv_[a-zA-Z0-9_-]+$/.test(fault.conversationId))
    assert(['send', 'page', 'history', 'epoch'].includes(fault.kind))
    assert(['success', 'failure', 'empty'].includes(fault.outcome))
    assert(
      Number.isInteger(fault.delayMs) &&
        fault.delayMs >= 0 &&
        fault.delayMs <= 60000
    )
    assert(
      Number.isInteger(fault.remaining) &&
        fault.remaining > 0 &&
        fault.remaining <= 100
    )
    assert(!this.gates.has(fault.gateId), 'Duplicate gate ID')
    assert(fault.outcome !== 'empty' || fault.kind === 'page')
    this.gates.set(fault.gateId, { ...fault })
  }

  claim(userId: string, method: string, url: URL): RecoveryFault | undefined {
    for (const fault of this.gates.values()) {
      if (fault.userId !== userId || fault.remaining === 0) continue
      const messages = `/api/v1/chat/conversations/${fault.conversationId}/messages`
      const match =
        fault.kind === 'send'
          ? method === 'POST' && url.pathname === messages
          : fault.kind === 'page'
            ? method === 'GET' &&
              url.pathname === messages &&
              url.searchParams.has('before')
            : fault.kind === 'epoch'
              ? method === 'POST' &&
                url.pathname ===
                  `/api/v1/chat/conversations/${fault.conversationId}/epochs`
              : method === 'GET' &&
                url.pathname ===
                  `/api/v1/chat/conversations/${fault.conversationId}/epochs` &&
                url.searchParams.has('boxesAfter')
      if (!match) continue
      fault.remaining--
      this.audit({ gateId: fault.gateId, remaining: fault.remaining })
      return { ...fault }
    }
    return undefined
  }

  async wait(fault: RecoveryFault): Promise<void> {
    if (fault.delayMs === 0) return
    await new Promise<void>(resolve => {
      const pending = this.releases.get(fault.gateId) ?? new Set()
      this.releases.set(fault.gateId, pending)
      const release = (): void => {
        clearTimeout(timer)
        pending.delete(release)
        if (pending.size === 0) this.releases.delete(fault.gateId)
        this.audit({
          gateId: fault.gateId,
          remaining: fault.remaining,
          event: 'delay-released'
        })
        resolve()
      }
      const timer = setTimeout(release, fault.delayMs)
      pending.add(release)
    })
  }

  clear(): void {
    for (const fault of this.gates.values())
      this.audit({
        gateId: fault.gateId,
        remaining: fault.remaining,
        event: 'cleared'
      })
    this.gates.clear()
    for (const pending of this.releases.values())
      for (const release of pending) release()
    this.releases.clear()
  }
}
