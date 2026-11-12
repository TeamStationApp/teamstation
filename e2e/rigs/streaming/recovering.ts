import type { MaestroDevice } from '../../core/maestro'

/**
 * A maestro-d device that comes back when its driver is lost. An iPhone's
 * WebDriverAgent has died mid-soak (every call then answers "connection reset
 * by peer" from its forwarded port) and maestro-d did not bring it back, so
 * the rest of the run was lost for that phone. On such an error this detaches,
 * attaches again (a new driver session), and retries the call once. A phone
 * that has dropped off USB for a moment is not there to attach to at once, so
 * the attach is tried a few times, some seconds apart.
 */

/** An error that means the driver is gone, not that the app said no. */
export function driverLost(message: string): boolean {
  if (/connection reset by peer|connection refused|broken pipe/i.test(message))
    return true
  // maestro-d stops a daemon left idle for half an hour, as a publisher's is
  // between starting its broadcast and stopping it: attaching again starts one.
  if (/DAEMON_UNAVAILABLE|daemon\.sock: connect ENOENT/.test(message))
    return true
  // The phone itself dropped off USB for a moment: maestro-d lets go of it.
  if (
    /DEVICE_NOT_ATTACHED|is not attached|not found\. Is it attached/.test(
      message
    )
  )
    return true
  // A request that never got its headers is a hung driver, except a long
  // press, which holds the request open as long as the press lasts.
  return (
    message.includes('Client.Timeout exceeded while awaiting headers') &&
    !/long_click|Failed to press at point/.test(message)
  )
}

export interface Recovery {
  atMs: number
  role: string
  call: string
  error: string
  /** When the device answered again, or null when it did not. */
  recoveredMs: number | null
  reattachError?: string
}

export interface RecoveringOptions {
  role: string
  attach: () => Promise<MaestroDevice>
  /** Told each time the driver was lost, recovered or not. */
  onRecovery?: (recovery: Recovery) => void
  now?: () => number
  /** How many times one recovery tries to attach, and how far apart. */
  attempts?: number
  retryGapMs?: number
  sleep?: (ms: number) => Promise<void>
  /** At most one reattach in this long: a device that keeps dying stays down. */
  cooldownMs?: number
}

export async function recoveringDevice(
  options: RecoveringOptions
): Promise<MaestroDevice> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  let current = await options.attach()
  let lastAttachMs = -Infinity
  let reattaching: Promise<boolean> | undefined

  const reattach = async (call: string, error: string): Promise<boolean> => {
    const atMs = now()
    if (atMs - lastAttachMs < (options.cooldownMs ?? 60_000)) return false
    lastAttachMs = atMs
    const recovery: Recovery = {
      atMs,
      role: options.role,
      call,
      error,
      recoveredMs: null
    }
    await current.detach().catch(() => undefined)
    const attempts = options.attempts ?? 4
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        current = await options.attach()
        recovery.recoveredMs = now()
        break
      } catch (reason) {
        recovery.reattachError = (reason as Error).message
        if (attempt < attempts) await sleep(options.retryGapMs ?? 20_000)
      }
    }
    if (recovery.recoveredMs != null) delete recovery.reattachError
    options.onRecovery?.(recovery)
    return recovery.recoveredMs != null
  }

  return new Proxy<MaestroDevice>(Object.create(null), {
    get(_target, name: string) {
      // Not a promise: `await` on the device must give the device.
      if (name === 'then') return undefined
      if (typeof current[name] !== 'function') return current[name]
      return async (...args: unknown[]) => {
        const used = current
        try {
          return await used[name](...args)
        } catch (error) {
          const message = (error as Error).message ?? String(error)
          if (name === 'detach' || !driverLost(message)) throw error
          // Another call has attached a new driver since this one began.
          if (current !== used) return await current[name](...args)
          // Calls that fail together share one reattach.
          reattaching ??= reattach(name, message).finally(() => {
            reattaching = undefined
          })
          if (!(await reattaching)) throw error
          return await current[name](...args)
        }
      }
    }
  })
}
