import { Agent } from 'undici'

/**
 * The bench's network conditioner on the bench network
 * (`https://shaper.example.test`): it drops, delays or
 * caps one address's traffic, but only for a device on the test networks
 * (test-net-1, test-net-2), which `GET /v1/devices` lists. A watcher's address
 * comes from the local settings (`soak.shapedIps`); its outage is a 100 % loss
 * shape on that address, always cleared.
 */

export const SHAPER = 'https://shaper.example.test'

export interface ShaperDevice {
  ip: string
  hostname: string | null
  ssid: string | null
}

export interface Shaper {
  /** The device on a test network at this address, or null when it is not on one. */
  onTestNetwork: (ip: string) => Promise<ShaperDevice | null>
  /** Drops all of the address's traffic for `ms`, then clears it, even when `during` throws. */
  outage: <T>(
    ip: string,
    ms: number,
    during?: () => Promise<T>
  ) => Promise<T | undefined>
}

export function shaper(
  options: {
    base?: string
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
  } = {}
): Shaper {
  const base = (options.base ?? SHAPER).replace(/\/$/, '')
  // The gateway serves its own certificate; the conditioner is LAN-only.
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  const call =
    options.fetch ??
    (async (url: string, init?: RequestInit) => {
      // undici's own option, which the DOM RequestInit type does not name.
      const withAgent: RequestInit & { dispatcher: Agent } = {
        ...init,
        dispatcher
      }
      return await fetch(url, withAgent)
    })
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  const shape = async (body: unknown): Promise<void> => {
    const answer = await call(`${base}/v1/shape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!answer.ok) {
      throw new Error(`the conditioner refused a shape: ${answer.status}`)
    }
  }
  return {
    onTestNetwork: async ip => {
      const answer = await call(`${base}/v1/devices`)
      if (!answer.ok) {
        throw new Error(
          `the conditioner would not list devices: ${answer.status}`
        )
      }
      const { devices } = (await answer.json()) as {
        devices: Array<{
          ip: string
          hostname: string | null
          ssid: string | null
        }>
      }
      const found = devices.find(device => device.ip === ip)
      return found == null
        ? null
        : { ip: found.ip, hostname: found.hostname, ssid: found.ssid }
    },
    outage: async (ip, ms, during) => {
      await shape([{ ip, lossPct: 100 }])
      try {
        const value = await during?.()
        await sleep(ms)
        return value
      } finally {
        await shape([{ ip }])
      }
    }
  }
}
