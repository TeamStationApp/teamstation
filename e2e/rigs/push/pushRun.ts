import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { generateVAPIDKeys } from 'web-push'

import { ROOT } from '../../core/manifest'
import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'

/** The device runs of `scripts/push-coverage.mjs`: the browser, the emulator and the simulator. */
export type PushRun = 'web' | 'android' | 'ios'

export interface PushRunResult {
  code: number
  /** What the run said, start to end. */
  log: string
  /** The scenarios' own logs and screenshots. */
  artifacts: string
}

/** What a run needs of this machine beyond what this rig makes: the Android build's toolchain. */
const MACHINE: Record<PushRun, string[]> = {
  web: [],
  android: ['JAVA_HOME', 'ANDROID_HOME', 'TS_ANDROID_DEBUG_KEYSTORE'],
  ios: []
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address == null || typeof address === 'string')
          reject(new Error('no port'))
        else resolve(address.port)
      })
    })
  })
}

/** This Mac's LAN address, which the simulator reaches the API on. */
function lanAddress(): string {
  const given = process.env.TS_PUSH_IOS_HOST
  if (given != null && given !== '') return given
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  throw new BlockedError('ios: this Mac has no LAN address for the simulator')
}

/**
 * One device run of the notification scenarios, through
 * `scripts/push-coverage.mjs run <run>`, the coverage gate's own: it starts
 * the API on a database of its own with the chat fixture in it (and the web
 * app, or Metro, or the measured simulator build), runs
 * `src/app/notifications.e2e.ts` (N1–N4) or
 * `mobile/test/teamStationAppNotifications.e2e.ts` (N5 on Android, N6 on
 * iOS), and stops what it started. This rig gives it a scratch database on
 * the local Postgres (`TS_TEST_DATABASE_URL`, dropped afterwards), ports of
 * its own, a VAPID pair made for the run, the device in role `phone`, and a
 * maestro-d daemon of its own, stopped afterwards. The run writes its
 * counters under `coverage/push/<run>`, as the gate's run does.
 */
export async function pushRun(
  ctx: E2eContext,
  run: PushRun
): Promise<PushRunResult> {
  for (const name of MACHINE[run]) {
    if (process.env[name] == null || process.env[name] === '') {
      throw new BlockedError(`${run}: set ${name} for the app's build`)
    }
  }
  const folder = ctx.artifact(`push-${run}`)
  const artifacts = ctx.artifact('notifications')
  for (const dir of [folder, artifacts]) mkdirSync(dir, { recursive: true })
  const postgres = new URL(
    process.env.TS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
  )
  const port = postgres.port === '' ? '5432' : postgres.port
  const name = `ts_e2e_push_${run}_${process.pid}_${Date.now()}`
  const database = `postgres://${postgres.hostname}:${port}/${name}`
  const daemon = `e2e-push-${run}-${process.pid}`
  let env: Record<string, string>
  if (run === 'web') {
    const vapid = join(folder, 'vapid.json')
    writeFileSync(
      vapid,
      JSON.stringify({
        ...generateVAPIDKeys(),
        subject: 'mailto:push@example.test'
      }),
      { mode: 0o600 }
    )
    env = {
      TS_PUSH_WEB_RUN: folder,
      TS_PUSH_WEB_DATABASE: database,
      TS_PUSH_VAPID: vapid,
      TS_PUSH_WEB_API_PORT: String(await freePort()),
      TS_PUSH_WEB_PORT: String(await freePort())
    }
  } else if (run === 'android') {
    env = {
      TS_PUSH_ANDROID_RUN: folder,
      TS_PUSH_ANDROID_DATABASE: database,
      TS_PUSH_ANDROID_DEVICE: ctx.device('phone'),
      MAESTRO_D: daemon,
      TS_PUSH_ANDROID_API_PORT: String(await freePort()),
      TS_PUSH_METRO_PORT: String(await freePort())
    }
  } else {
    env = {
      TS_PUSH_IOS_RUN: folder,
      TS_PUSH_IOS_DATABASE: database,
      TS_PUSH_IOS_DEVICE: ctx.device('phone'),
      TS_PUSH_IOS_HOST: lanAddress(),
      MAESTRO_D: daemon,
      TS_PUSH_IOS_API_PORT: String(await freePort())
    }
  }
  const log = ctx.artifact(`push-${run}.log`)
  const out = createWriteStream(log)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['scripts/push-coverage.mjs', 'run', run],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Only the gate reads the base; a run needs one all the same.
            TS_COVERAGE_BASE: 'HEAD',
            TS_NOTIFY_ARTIFACTS: artifacts,
            ...env
          }
        }
      )
      child.stdout.pipe(out, { end: false })
      child.stderr.pipe(out, { end: false })
      child.once('error', reject)
      child.once('close', status => {
        resolve(status ?? 1)
      })
    })
    return { code, log, artifacts }
  } finally {
    out.end()
    spawnSync('dropdb', [
      '-h',
      postgres.hostname,
      '-p',
      port,
      '--if-exists',
      '--force',
      name
    ])
    // The phone scripts start the daemon they are named, and leave it up.
    if (run !== 'web') {
      const bin =
        process.env.MAESTRO_D_BIN != null && process.env.MAESTRO_D_BIN !== ''
          ? process.env.MAESTRO_D_BIN
          : join(homedir(), '.maestro-d', 'bin', 'maestro-d')
      spawnSync(bin, ['stop', '--daemon', daemon])
    }
  }
}
