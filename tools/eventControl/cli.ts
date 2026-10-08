import { readFileSync } from 'node:fs'

import { asCredentials, type Credentials } from './codec'

/**
 * What the event-control tools share: reading a token file, fetching the
 * caller's own key with it, and printing one JSON line per event.
 */

/** A bearer token from a file holding nothing else (trailing newline allowed). */
export function readToken(file: string): string {
  const token = readFileSync(file, 'utf8').trim()
  if (token === '') throw new Error(`${file} holds no token`)
  return token
}

/** `https://host` or `http://127.0.0.1:9100`, with any trailing slash or `/api/v1` removed. */
export function serverBase(server: string): string {
  return server.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
}

/** This device's own key, fetched with its own session. */
export async function fetchCredentials(
  server: string,
  token: string,
  fetcher: typeof fetch = fetch
): Promise<Credentials> {
  const response = await fetcher(
    `${serverBase(server)}/api/v1/device-event-control/key`,
    { headers: { authorization: `Bearer ${token}` } }
  )
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const said = body as { error?: string; message?: string } | undefined
    throw new Error(
      `key request answered ${response.status}: ${said?.error ?? said?.message ?? ''}`
    )
  }
  return asCredentials(body)
}

/** Credentials as a log may show them: everything but the key. */
export function redacted(credentials: Credentials): Record<string, string> {
  return {
    issuer: credentials.issuer,
    userId: credentials.userId,
    accountTag: credentials.accountTag,
    keyId: credentials.keyId,
    key: '<redacted>'
  }
}

export type Log = (line: Record<string, unknown>) => void

/** One JSON line per event on stdout, stamped. */
export const printLog: Log = line => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...line }))
}

/** `--name value` and `--flag` arguments. */
export function parseArgs(
  argv: string[],
  flags: string[]
): Map<string, string | true> {
  const out = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (flags.includes(name)) {
      out.set(name, true)
      continue
    }
    const value = argv[i + 1]
    if (value == null || value.startsWith('--'))
      throw new Error(`--${name} needs a value`)
    out.set(name, value)
    i++
  }
  return out
}

/** A required string argument. */
export function required(args: Map<string, string | true>, name: string): string {
  const value = args.get(name)
  if (typeof value !== 'string') throw new Error(`--${name} is required`)
  return value
}

/** `host:port`, with IPv6 in brackets. */
export function parseEndpoint(text: string): { host: string; port: number } {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(text)
  if (match == null) throw new Error(`not host:port: ${text}`)
  return { host: match[1], port: Number(match[2]) }
}
