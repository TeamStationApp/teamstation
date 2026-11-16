import { resolve } from 'node:path'

import { Agent } from 'undici'

/**
 * A network conditioner, for a watcher's outage. A bench's own conditioner
 * and its client are the bench's, not this repository's: the local settings
 * name a module (`soak.shaper`) that exports `shaper(tools): Shaper`. A
 * watcher's address comes from the local settings too (`soak.shapedIps`).
 */

export interface ShaperDevice {
  ip: string
  hostname: string | null
  ssid: string | null
}

export interface Shaper {
  /** The device on a shaped network at this address, or null when it is not on one. */
  onTestNetwork: (ip: string) => Promise<ShaperDevice | null>
  /** Drops all of the address's traffic for `ms`, then clears it, even when `during` throws. */
  outage: <T>(
    ip: string,
    ms: number,
    during?: () => Promise<T>
  ) => Promise<T | undefined>
}

/** What a conditioner's module is handed. */
export interface ShaperTools {
  /** `fetch` that accepts a LAN device's own certificate. */
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const TOOLS: ShaperTools = {
  fetch: async (url, init) => {
    // undici's own option, which the DOM RequestInit type does not name.
    const withAgent: RequestInit & { dispatcher: Agent } = {
      ...init,
      dispatcher
    }
    return await fetch(url, withAgent)
  },
  sleep: async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

/** The conditioner the module at `path` makes. */
export function loadShaper(
  path: string,
  tools: ShaperTools = TOOLS,
  load: (file: string) => unknown = require
): Shaper {
  const loaded = load(resolve(path)) as { shaper?: unknown }
  if (typeof loaded?.shaper !== 'function') {
    throw new Error(`${path} exports no shaper(tools)`)
  }
  const made = (loaded.shaper as (tools: ShaperTools) => Partial<Shaper>)(tools)
  if (
    typeof made?.onTestNetwork !== 'function' ||
    typeof made.outage !== 'function'
  ) {
    throw new Error(`${path}'s shaper has no onTestNetwork and outage`)
  }
  return made as Shaper
}
