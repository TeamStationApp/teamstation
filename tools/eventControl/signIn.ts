import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

import { type Log, parseArgs, printLog, required, serverBase } from './cli'

/**
 * Signs one account in with the server's e-mail code and keeps its token in a
 * file for the other event-control tools.
 *
 *   node -r sucrase/register tools/eventControl/signIn.ts --server <url> \
 *     --email <address> --out <file>
 *
 * Asks the server to send a code (`POST /api/v1/auth/email-code`), reads the
 * code from stdin, verifies it (`POST /api/v1/auth/email-code/verify`) and
 * writes the session token to `--out` with mode 600. Keep that file outside
 * every repository. The token is never printed.
 */

/** The first line of `input`. */
export async function readLine(input: Readable): Promise<string> {
  const lines = createInterface({ input })
  try {
    for await (const line of lines) return line.trim()
  } finally {
    lines.close()
  }
  throw new Error('no code was given')
}

export async function signIn(options: {
  server: string
  email: string
  out: string
  input: Readable
  log: Log
  fetcher?: typeof fetch
}): Promise<{ userId: string }> {
  const fetcher = options.fetcher ?? fetch
  const api = `${serverBase(options.server)}/api/v1`
  const post = async (path: string, body: unknown): Promise<Response> =>
    await fetcher(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  const asked = await post('/auth/email-code', { email: options.email })
  if (asked.status !== 202)
    throw new Error(`asking for a code answered ${asked.status}`)
  options.log({ event: 'codeRequested', email: options.email })
  const code = await readLine(options.input)
  const verified = await post('/auth/email-code/verify', {
    email: options.email,
    code,
    deviceName: 'event-control tool'
  })
  if (!verified.ok)
    throw new Error(`verifying the code answered ${verified.status}`)
  const session = (await verified.json()) as {
    token: string
    user: { id: number | string }
  }
  mkdirSync(dirname(options.out), { recursive: true, mode: 0o700 })
  writeFileSync(options.out, `${session.token}\n`, { mode: 0o600 })
  chmodSync(options.out, 0o600)
  const userId = String(session.user.id)
  options.log({ event: 'signedIn', userId, tokenFile: options.out })
  return { userId }
}

export async function main(
  argv: string[],
  input: Readable = process.stdin,
  log: Log = printLog,
  fetcher?: typeof fetch
): Promise<{ userId: string }> {
  const args = parseArgs(argv, [])
  return await signIn({
    server: required(args, 'server'),
    email: required(args, 'email'),
    out: required(args, 'out'),
    input,
    log,
    fetcher
  })
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(String(error))
    process.exit(1)
  })
}
