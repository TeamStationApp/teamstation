import { execFile } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'

import { requireDropletHandle } from '../core/dropletStack'
import type { E2eContext } from '../core/spec'
import { SSH_OPTIONS } from '../core/streamingStack'

export class FixtureEmailRateLimit extends Error {}

/** The isolated server delivers its fresh fixture accounts' sign-in links to its log. */
export async function scoringFixtureLink(
  ctx: E2eContext,
  email: string,
  platform: 'ios' | 'android' | 'web'
): Promise<string> {
  if (ctx.stack.attached == null)
    throw new Error('Fixture sign-in needs an isolated stack')
  const stack = requireDropletHandle(ctx.stack.attached)
  if (
    !/^[A-Za-z0-9_.+@-]+$/.test(email) ||
    !/^[/A-Za-z0-9_.-]+$/.test(stack.serverLog)
  )
    throw new Error('Invalid fixture mailbox or log path')
  const sent = await fetch(stack.api + '/auth/email-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, origin: platform })
  })
  if (sent.status === 429)
    throw new FixtureEmailRateLimit('Fixture email requests are rate limited')
  if (sent.status !== 202)
    throw new Error('Fixture sign-in returned ' + sent.status)
  const match = 'sign-in code for ' + email + ':'
  for (let attempt = 0; attempt < 12; attempt++) {
    const { stdout } = await promisify(execFile)(
      'ssh',
      [
        ...SSH_OPTIONS,
        stack.ssh,
        "grep -F -A1 '" + match + "' " + stack.serverLog + ' | tail -2'
      ],
      { timeout: 10000 }
    )
    const found =
      /link: https?:\/\/[^/\s]+\/signin(?:-browser)?\/([\w-]+)/.exec(stdout)
    if (found != null) return 'signin/' + found[1]
    await pause(300)
  }
  throw new Error('The isolated stack did not deliver the fixture sign-in')
}
