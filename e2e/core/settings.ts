import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BlockedError } from './result'

/**
 * What a public repository must not hold, in one file every worktree shares:
 * `~/.config/teamstation-e2e/local.json`. `e2e/local.example.json` shows it.
 */
export interface SeatSettings {
  origin: string
}

export interface LocalSettings {
  seats?: Record<string, SeatSettings>
  seatCommand?: string
  goldenStore?: string
  mailbox?: string
  /** Where the tester seat's `baseline` manifest is, mode 0600, on this machine. */
  seatManifest?: string
  gogEnvFile?: string
  maestroClientRoot?: string
  maestroBin?: string
  /** Where a binary built elsewhere finds its drivers. */
  maestroHome?: string
  secretsFile?: string
  judgeBudgetUsd?: number
  sweepRef?: string
  /** Where runs and fault proofs are recorded, on the machine that ran them. */
  ledger?: string
  /**
   * The command that brings droplet stacks up and down: the devops repo's
   * e2e-stack, e.g. ["npm", "--prefix", "~/git/teamstation-devops", "run", "-s", "e2e-stack", "--"].
   * `stack up` adds `up --ref <ref>`, `stack down` adds `down <id>`, and
   * `stack prune` adds `reap`.
   */
  stackProvider?: { command: string[] }
  /**
   * A maestro-d hub to drive devices through instead of a daemon on this
   * machine: its address, and a file (mode 0600) holding its client token.
   * Device ids are then the hub's, `<udid>@<hub>`.
   */
  maestroHub?: {
    address: string
    tokenFile: string
    /** Signs WebDriverAgent on a hub's real iPhones and iPads. */
    teamId?: string
  }
  /**
   * The bench camera's stream, and where each device's screen sits in its
   * frame and its field's place at rest there (`w:h:x:y:fieldY`, then `:cw` or
   * `:ccw` for a phone held sideways), worked out afresh before each run that
   * reads motion (`e2e/rigs/app/keyboardMotion.ts`).
   */
  webcam?: { url: string; crops?: Record<string, string> }
  /**
   * A real TS Director take of several gigabytes on this machine, which
   * `playback/recordings/director-take-finish` uploads to time the finish.
   */
  directorTake?: string
}

export function settingsPath(env = process.env): string {
  return (
    env.E2E_LOCAL_SETTINGS ??
    join(homedir(), '.config', 'teamstation-e2e', 'local.json')
  )
}

/** `~/x` as a path under `home`; any other value as it is. */
export function expandHome(value: unknown, home = homedir()): unknown {
  return typeof value === 'string' && value.startsWith('~/')
    ? join(home, value.slice(2))
    : value
}

/** `~/` expanded in a value, and in the strings of an object one level down. */
function expandSetting(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    return expandHome(value)
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, expandHome(inner)])
  )
}

export function loadSettings(path = settingsPath()): LocalSettings {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, expandSetting(value)])
  )
}

/** A secret by name, from the file the settings point at. */
export function readSecret(settings: LocalSettings, name: string): string {
  const file = settings.secretsFile
  if (file == null || !existsSync(file)) {
    throw new BlockedError(`secret "${name}": no secrets file is configured`)
  }
  const secrets = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    unknown
  >
  const value = secrets[name]
  if (typeof value !== 'string' || value === '') {
    throw new BlockedError(`secret "${name}" is not in the secrets file`)
  }
  return value
}

export function hasSecret(settings: LocalSettings, name: string): boolean {
  try {
    readSecret(settings, name)
    return true
  } catch {
    return false
  }
}
