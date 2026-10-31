import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BlockedError, HarnessError } from './result'
import type { LocalSettings } from './settings'

/**
 * What a fixture made. A manifest holds passwords, so one for a world stays in the
 * running scenario's memory, and only `baseline`'s is ever on disk, mode 0600.
 */
export interface FixtureAccount {
  role: string
  email: string
  password: string
  userId: string
  displayName: string
}

export interface FixtureManifest {
  world: string
  nonce: string
  accounts: Record<string, FixtureAccount>
  ids: Record<string, string>
}

export function requireMailbox(settings: LocalSettings): string {
  if (settings.mailbox == null) {
    throw new BlockedError('no test mailbox: set mailbox in the local settings')
  }
  return settings.mailbox
}

/** Runs the fixtures script against the database in `cwd`'s server configuration. */
export function runLocalFixture(
  root: string,
  cwd: string,
  world: string,
  mailbox: string
): FixtureManifest {
  const ran = spawnSync(
    process.execPath,
    [
      '-r',
      require.resolve('sucrase/register'),
      join(root, 'src/server/dev/fixtures/cli.ts'),
      world,
      '--json',
      '--mailbox',
      mailbox
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }
  )
  if (ran.status !== 0) {
    throw new HarnessError(`Fixture ${world} failed: ${ran.stderr}`)
  }
  return JSON.parse(ran.stdout) as FixtureManifest
}

/** Asks the seat's command to seed a world, and reads the manifest it prints. */
export function runSeatFixture(
  settings: LocalSettings,
  seat: string,
  world: string
): FixtureManifest {
  if (settings.seatCommand == null) {
    throw new BlockedError(
      'no seat command: set seatCommand in the local settings'
    )
  }
  const output = execFileSync(
    settings.seatCommand,
    ['seed', world, '--seat', seat],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return JSON.parse(output) as FixtureManifest
}

export function writeManifestFile(
  path: string,
  manifest: FixtureManifest
): void {
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
}

/**
 * Where `baseline`'s manifest is for this target. Only the tester seat and an isolated
 * stack have one: a branch seat holds a production copy, which `baseline` refuses.
 */
export function baselineManifestPath(
  settings: LocalSettings,
  target: { kind: string; seat?: string; dir?: string }
): string | undefined {
  if (target.kind === 'isolated') {
    return target.dir == null ? undefined : join(target.dir, 'baseline.json')
  }
  if (target.kind === 'seat' && target.seat === 'tester') {
    return settings.seatManifest
  }
  return undefined
}

export function readBaselineManifest(
  path: string | undefined
): FixtureManifest | undefined {
  if (path == null || !existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest
}

/** A role's account from the worlds this scenario seeded, then from `baseline`. */
export function findAccount(
  role: string,
  worlds: FixtureManifest[],
  baseline: FixtureManifest | undefined
): FixtureAccount {
  for (const manifest of [...worlds].reverse()) {
    const found = manifest.accounts[role]
    if (found != null) return found
  }
  const found = baseline?.accounts[role]
  if (found != null) return found
  throw new BlockedError(
    `no account for role "${role}": seed a world that has it, or use a target with baseline`
  )
}

/** The real password form, on any surface. */
export async function signInWithPassword(
  device: any,
  account: Pick<FixtureAccount, 'email' | 'password'>
): Promise<void> {
  await device.assertVisible({ text: 'Use a password instead', timeout: 30000 })
  await device.tapOn({ text: 'Use a password instead' })
  await device.tapOn({ text: 'E-mail address' })
  await device.inputText({ text: account.email })
  await device.tapOn({ text: 'Password' })
  await device.inputText({ text: account.password })
  await device.tapOn({ text: 'Sign in' })
  // Only a signed-in person has the account button, so a refused password fails here.
  await device.assertVisible({ text: 'Account, .*', timeout: 20000 })
}

/** Every id a world made, so a seat's 5xx can be claimed by the scenario it names. */
export function worldIdsOf(worlds: FixtureManifest[]): string[] {
  return worlds.flatMap(manifest => [
    ...Object.values(manifest.ids),
    ...Object.values(manifest.accounts).map(account => account.userId)
  ])
}
