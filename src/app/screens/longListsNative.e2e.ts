import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type LongListsSeed, longListsSupport } from '../../test/longListsSeed'
import { log, maestro } from '../../test/refinementsMaestro.e2e'

/**
 * The long lists scenarios on a phone, through maestro-d's JavaScript library,
 * against `src/test/longListsFixture.e2e.ts`.
 *
 *   TS_LONG_LISTS_ARTIFACTS=… TS_LONG_LISTS_DEVICE=<id> \
 *   TS_LONG_LISTS_PLATFORM=ios|android TS_LONG_LISTS_CASES=E5,E6 \
 *   TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/app/screens/longListsNative.e2e.ts
 *
 * `TS_LONG_LISTS_DEVICE` is looked up when the run starts, never written here.
 * The manifest is the fixture's, and the app was built against its
 * `apiBaseUrl`. A `later` step names what a milestone asserts there.
 */
interface Device {
  launchApp: (options?: unknown) => Promise<unknown>
  stopApp: (options?: unknown) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (selector: unknown) => Promise<unknown>
  assertVisible: (selector: unknown) => Promise<unknown>
  swipe: (options: unknown) => Promise<unknown>
  hierarchy: () => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: () => Promise<unknown>
  detach: () => Promise<unknown>
}

interface Manifest extends LongListsSeed {
  origin: string
  apiBaseUrl: string
  email: string
  signInLinkRoute: string
}

const APP_ID = 'app.teamstation.app'
const ALL_CASES = 'E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12'

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}`)
  return value
}

/** One of a milestone's steps, empty until that milestone. */
function later(step: string): void {
  console.log(`  later: ${step}`)
}

async function main(): Promise<void> {
  const artifacts = required('TS_LONG_LISTS_ARTIFACTS')
  const device = required('TS_LONG_LISTS_DEVICE')
  const platform = required('TS_LONG_LISTS_PLATFORM')
  assert.ok(platform === 'ios' || platform === 'android', platform)
  const support = longListsSupport()
  await mkdir(artifacts, { recursive: true })
  const manifest = JSON.parse(
    await readFile(join(support, 'native-manifest.json'), 'utf8')
  ) as Manifest
  const chosen = (process.env.TS_LONG_LISTS_CASES ?? ALL_CASES)
    .split(',')
    .map(name => name.trim())
  const daemon = await maestro(`longListsNative-${platform}`)
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const m = (await daemon.attach({
    device,
    platform,
    appId: APP_ID,
    artifacts: 'on-failure',
    ...(teamId != null && teamId !== '' ? { teamId } : {})
  })) as unknown as Device
  const note = async (line: string): Promise<void> => {
    await log(support, `longLists-${platform}.log`, line)
  }
  const visible = async (text: string, timeout = 15000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const shown = async (text: string, timeout = 3000): Promise<boolean> =>
    await m
      .assertVisible({ text, timeout })
      .then(() => true)
      .catch(() => false)
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  const scrollDown = async (times: number): Promise<void> => {
    for (let swipe = 0; swipe < times; swipe++)
      await m.swipe({ start: '50%, 75%', end: '50%, 25%', duration: 300 })
  }
  const recorded = async (
    name: string,
    run: () => Promise<void>
  ): Promise<void> => {
    await m.startRecording({ path: join(artifacts, name) })
    try {
      await run()
    } finally {
      await m.stopRecording()
    }
  }
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name), await m.screenshot())
  }
  const signIn = async (): Promise<void> => {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    if (!(await shown('Sign in to TeamStation', 15000))) return
    const asked = await fetch(`${manifest.apiBaseUrl}/auth/email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: manifest.email })
    })
    assert.equal(asked.status, 202)
    const answer = await fetch(
      `${manifest.origin}${manifest.signInLinkRoute}?email=${encodeURIComponent(manifest.email)}`
    )
    assert.ok(answer.ok, 'No sign-in mail')
    const { link } = (await answer.json()) as { link?: string }
    const token = link?.split('/signin/')[1]
    assert.ok(token != null && token !== '', `No sign-in link in ${link}`)
    await m.openLink({ link: `teamstation://signin/${token}` })
    await visible('Your Home', 30000)
  }
  const onSchedule = async (): Promise<void> => {
    await m.openLink({ link: 'teamstation://schedule' })
    await visible('Upcoming')
  }

  const webOnly = (name: string) => async () => {
    await note(`${name}: a browser scenario, in src/test/longLists.e2e.ts`)
  }
  const cases: Record<string, () => Promise<void>> = {
    E1: webOnly('E1'),
    E2: webOnly('E2'),
    E3: webOnly('E3'),
    E4: webOnly('E4'),
    E5: async () => {
      later('M5: wait on Home, go offline, open Schedule; it paints offline')
      await recorded(`${platform}-schedule-pills.mp4`, async () => {
        await onSchedule()
        await tap('Past')
        await scrollDown(4)
        await tap('All')
        await tap('Past')
      })
      later('M5: the card and pills pin; slides show rows; the end shows Retry')
      await shot(`${platform}-offline-paint.png`)
    },
    E6: async () => {
      await recorded(`${platform}-team-older-rows.mp4`, async () => {
        await m.openLink({ link: `teamstation://teams/${manifest.teamId}` })
        await visible('Team sections')
        later('M6: opens under the pills at the next game')
        await tap('Videos')
        await tap('Schedule')
        later('M6: anchors again; older rows arrive above; the reader stays')
      })
      await recorded(`${platform}-rsvp-row-state.mp4`, async () => {
        later('M6: answer an RSVP, scroll away and back; the answer stays')
      })
    },
    E7: async () => {
      await m.openLink({ link: `teamstation://seasons/${manifest.seasonId}` })
      await visible('Season sections')
      later('M6: Past at depth, Upcoming, Past, All, Videos; hero counts hold')
    },
    E8: webOnly('E8'),
    E9: async () => {
      await m.openLink({ link: 'teamstation://notifications' })
      await visible('Pending')
      later('M7: pages in each mode; a dismissed row leaves; no Load more')
    },
    E10: async () => {
      await m.openLink({ link: `teamstation://players/${manifest.playerId}` })
      await visible('Player sections')
      later('M8: auto-loads to the last highlight; no Show more')
    },
    E11: async () => {
      await m.openLink({
        link: `teamstation://games/${manifest.highlightsGameId}`
      })
      await visible('Game sections')
      await tap('Videos')
      later('M8: current row marks; jumpTo seeks; the player does not move')
    },
    E12: async () => {
      await m.openLink({ link: `teamstation://umpires/${manifest.leagueId}` })
      await visible('Umpire')
      later("M9: opens on the rule's game; sideways; notes; sign-up; removal")
    }
  }

  try {
    await note(
      `$ TS_LONG_LISTS_PLATFORM=${platform} TS_LONG_LISTS_CASES=${chosen.join(',')} node -r sucrase/register src/app/screens/longListsNative.e2e.ts`
    )
    await signIn()
    for (const name of chosen) {
      const run = cases[name]
      if (run == null) throw new Error(`No case ${name}`)
      await note(`${name}: start`)
      await run()
      await note(`${name}: done`)
    }
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
