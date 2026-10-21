/**
 * A sign-in link for the player-layouts fixture's administrator, for a phone
 * a test cannot type into: the server is asked to send a code
 * (`POST /auth/email-code`), and with no mail configured it logs the link
 * instead, which this reads back from the server's log and prints, alone.
 *
 *   node -r sucrase/register scripts/e2e/playerLayouts/signInLink.ts \
 *     <server log> [<path to land on>]
 */
import { readFileSync } from 'node:fs'

import { API, fixture } from '../../../src/app/player/playerLayoutsRig.e2e'

async function main(): Promise<void> {
  const [log, next] = process.argv.slice(2)
  if (log == null) throw new Error('Give the server log')
  const email = fixture().admin.email
  const before = readFileSync(log, 'utf8').length
  const asked = await fetch(`${API}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, ...(next == null ? {} : { next }) })
  })
  if (!asked.ok) throw new Error(`asked for a code: HTTP ${asked.status}`)
  for (let tries = 0; tries < 40; tries++) {
    const added = readFileSync(log, 'utf8').slice(before)
    const link = /\[no mail configured\] link: (\S+)/.exec(added)?.[1]
    if (link != null) {
      process.stdout.write(link)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('no link in the server log')
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
