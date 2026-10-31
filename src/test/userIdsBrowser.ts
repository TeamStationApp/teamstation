import { execFileSync } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { BrowserSession } from '../../e2e/rigs/refinementsMaestro'
import { browserSession, log, maestro } from '../../e2e/rigs/refinementsMaestro'

const LOCK = join(tmpdir(), 'teamstation-user-ids-browser.lock')
const SEAT = 'https://develop7.teamstation.app'

/** Hosted navigation is opt-in and restricted to this task's assigned seat. */
export function userIdsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const seat = env.TS_USER_IDS_SEAT_ORIGIN
  if (seat != null) {
    if (seat !== SEAT)
      throw new Error('User ID tests require the assigned development seat')
    return seat
  }
  const local = new URL(env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8180')
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) ||
    local.protocol !== 'http:' ||
    local.username !== '' ||
    local.password !== ''
  )
    throw new Error('Local browser tests require a loopback HTTP origin')
  if (local.pathname !== '/' || local.search !== '' || local.hash !== '')
    throw new Error('Supply an origin, without a path or query')
  return local.origin
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

/** Match the unique profile, never a browser belonging to another task. */
function browserPids(profile: string): number[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes('--user-data-dir=') && line.includes(profile))
    .map(line => Number(/^\s*(\d+)/.exec(line)?.[1]))
    .filter(pid => Number.isInteger(pid) && pid > 1)
}

export async function browserLock(
  profile: string,
  path = LOCK,
  running: (pid: number) => boolean = alive,
  owned: (profile: string) => number[] = browserPids
): Promise<() => Promise<void>> {
  const record = JSON.stringify({ pid: process.pid, profile })
  try {
    await writeFile(path, record, { flag: 'wx', mode: 0o600 })
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error
    const old = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isInteger(old.pid) || typeof old.profile !== 'string')
      throw new Error('Unrecognized browser lock; inspect it before proceeding')
    if (running(old.pid) || owned(old.profile).length > 0)
      throw new Error('Another user ID test still owns the browser')
    // Removing a stale lock automatically can race another claimant. Leave it
    // for explicit recovery after checking the dead owner and profile.
    throw new Error(
      'Stale browser lock: owner and Chromium exited; remove the verified lock before retrying'
    )
  }
  return async () => {
    if (owned(profile).length > 0)
      throw new Error('Owned Chromium is still running; retaining lock')
    if ((await readFile(path, 'utf8')) !== record)
      throw new Error('Browser lock changed unexpectedly')
    await unlink(path)
  }
}

export interface BrowserCleanup {
  exportCoverage?: () => Promise<void>
  closeBrowser?: () => Promise<void>
  detach?: () => Promise<void>
  shutdown?: () => Promise<void>
  confirmExit: () => Promise<void>
  release: () => Promise<void>
}

/** Each cleanup step runs even when an earlier step fails. */
export async function cleanupBrowser(actions: BrowserCleanup): Promise<void> {
  const failures: unknown[] = []
  for (const action of [
    actions.exportCoverage,
    actions.closeBrowser,
    actions.detach,
    actions.shutdown
  ]) {
    try {
      await action?.()
    } catch (error) {
      failures.push(error)
    }
  }
  // Keep the lock if process exit could not be confirmed.
  await actions.confirmExit()
  await actions.release()
  if (failures.length > 0)
    throw new AggregateError(failures, 'Browser cleanup reported failures')
}

async function confirmBrowserExit(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pids = browserPids(profile)
    if (pids.length === 0) return
    if (attempt === 20 || attempt === 35)
      for (const pid of pids) {
        try {
          process.kill(pid, attempt === 20 ? 'SIGTERM' : 'SIGKILL')
        } catch (error: any) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Owned Chromium did not exit')
}

/** One task-wide lock also covers launch failures and interruption. */
export async function withUserIdsBrowser<T>(
  artifacts: string,
  scenario: (session: BrowserSession, origin: string) => Promise<T>,
  exportCoverage?: (session: BrowserSession) => Promise<void>
): Promise<T> {
  const origin = userIdsOrigin()
  const device = `user-ids-${process.pid}`
  const profile = resolve(artifacts, 'support', 'browser-profiles', device)
  await mkdir(artifacts, { recursive: true })
  const release = await browserLock(profile)
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let session: BrowserSession | undefined
  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    closing ??= cleanupBrowser({
      exportCoverage: async () => {
        if (session != null) await exportCoverage?.(session)
      },
      closeBrowser: async () => {
        await session?.browser.close()
      },
      detach: async () => {
        await session?.m.detach()
      },
      shutdown: async () => {
        await daemon?.shutdown()
      },
      confirmExit: async () => {
        await confirmBrowserExit(profile)
        await log(
          artifacts,
          'browser-cleanup.log',
          `$ cleanup ${device}: owned Chromium processes exited`
        )
      },
      release
    })
    await closing
  }
  const interrupt = (signal: NodeJS.Signals): void => {
    close().then(
      () => process.exit(signal === 'SIGINT' ? 130 : 143),
      () => process.exit(1)
    )
  }
  const sigint = (): void => {
    interrupt('SIGINT')
  }
  const sigterm = (): void => {
    interrupt('SIGTERM')
  }
  process.once('SIGINT', sigint)
  process.once('SIGTERM', sigterm)
  const failures: unknown[] = []
  let result!: T
  try {
    await log(
      artifacts,
      'browser-cleanup.log',
      `$ launch ${device}: exclusive browser lock acquired`
    )
    daemon = await maestro(process.env.MAESTRO_D ?? 'userIds')
    session = await browserSession(
      daemon,
      device,
      402,
      874,
      artifacts,
      'chromium'
    )
    result = await scenario(session, origin)
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      await close()
    } catch (cleanupError) {
      failures.push(cleanupError)
    } finally {
      process.removeListener('SIGINT', sigint)
      process.removeListener('SIGTERM', sigterm)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures
        .map(error =>
          error instanceof Error ? error.message : 'Unknown browser failure'
        )
        .join('; ')
    )
  return result
}
