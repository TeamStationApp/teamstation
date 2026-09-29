/**
 * maestro-d for the phone and iPad tests: one daemon per agent, one pinned
 * device, and screenshots saved where the run can find them.
 *
 * The JavaScript client is loaded the way scripts/scoring-feedback-safari.mjs
 * loads it: from MAESTRO_D_CLIENT_ROOT, a maestro-d checkout's npm/maestro-d
 * directory, by default ~/git/maestro-d/npm/maestro-d. The binary it spawns
 * the daemon from is MAESTRO_D_BIN, by default ~/.maestro-d/bin/maestro-d.
 * The client's docs are in ~/git/maestro-d/docs/daemon/. MAESTRO_D_TEAM_ID is
 * the team that signs WebDriverAgent on a physical iOS device.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The part of maestro-d's `MaestroDevice` these tests use. */
export interface MaestroDevice {
  launchApp: (value?: unknown) => Promise<unknown>
  stopApp: (value?: unknown) => Promise<unknown>
  openLink: (value: unknown) => Promise<unknown>
  tapOn: (value: unknown) => Promise<unknown>
  inputText: (value: unknown) => Promise<unknown>
  eraseText: (value?: unknown) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  back: () => Promise<unknown>
  assertVisible: (value: unknown) => Promise<unknown>
  assertNotVisible: (value: unknown) => Promise<unknown>
  extendedWaitUntil: (value: unknown) => Promise<unknown>
  scrollUntilVisible: (value: unknown) => Promise<unknown>
  swipe: (value: unknown) => Promise<unknown>
  copyTextFrom: (value: unknown) => Promise<{ data?: unknown }>
  screenshot: () => Promise<Buffer>
  hierarchy: () => Promise<HierarchyNode>
  detach: () => Promise<unknown>
}

export interface HierarchyNode {
  type?: string
  id?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: HierarchyNode[]
}

export interface AttachedDevice extends MaestroDevice {
  /** Saves a PNG of the screen as `<artifactDir>/<nn>-<name>.png`. */
  shot: (name: string) => Promise<string>
  artifactDir: string
}

/** The maestro-d client package, from its checkout. */
export function maestroClient(): {
  MaestroD: {
    connect: (options: { name: string; spawn?: boolean; bin?: string }) => Promise<{
      attach: (options: Record<string, unknown>) => Promise<MaestroDevice>
    }>
  }
} {
  const root = resolve(
    process.env.MAESTRO_D_CLIENT_ROOT ??
      join(homedir(), 'git', 'maestro-d', 'npm', 'maestro-d')
  )
  return createRequire(join(root, 'package.json'))('maestro-d')
}

/** The maestro-d binary: MAESTRO_D_BIN, the usual install, or PATH. */
export function maestroBin(): string {
  if (process.env.MAESTRO_D_BIN != null && process.env.MAESTRO_D_BIN !== '') {
    return process.env.MAESTRO_D_BIN
  }
  const installed = join(homedir(), '.maestro-d', 'bin', 'maestro-d')
  return existsSync(installed) ? installed : 'maestro-d'
}

/** Every node of a hierarchy, depth first. */
export function flatten(node: HierarchyNode): HierarchyNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

/**
 * Attaches `device` to the daemon `daemon`, after listing every daemon so a
 * device another agent holds is visible in the log before the attach fails.
 */
export async function attach(options: {
  daemon: string
  device: string | undefined
  appId: string
  artifactDir?: string
}): Promise<AttachedDevice> {
  const { daemon, device, appId } = options
  if (device == null || device === '') {
    throw new Error(
      'No device: pin one (ANDROID_SERIAL or DIRECTOR_DEVICE_UDID). ' +
        'These tests never pick a device for themselves.'
    )
  }
  const bin = maestroBin()
  process.env.MAESTRO_D_BIN = bin
  const ps = execFileSync(bin, ['ps'], { encoding: 'utf8' })
  console.log(`maestro-d ps:\n${ps.trim()}`)

  const { MaestroD } = maestroClient()
  const connection = await MaestroD.connect({ name: daemon, bin })
  // A physical iPad or iPhone signs WebDriverAgent with a development team,
  // and is attached by its hardware UDID (00008132-…), not the CoreDevice
  // identifier `devicectl list devices` prints.
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const handle = await connection.attach({
    device,
    appId,
    ...(teamId != null && teamId !== '' ? { teamId } : {})
  })

  const artifactDir =
    options.artifactDir ??
    process.env.E2E_ARTIFACT_DIR ??
    join('/tmp', 'maestroD', daemon, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(artifactDir, { recursive: true })
  let serial = 0
  const shot = async (name: string): Promise<string> => {
    const path = join(artifactDir, `${String(++serial).padStart(2, '0')}-${name}.png`)
    writeFileSync(path, await handle.screenshot())
    console.log(`screenshot ${path}`)
    return path
  }
  return Object.assign(handle, { shot, artifactDir })
}
