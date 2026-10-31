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
  gogEnvFile?: string
  maestroClientRoot?: string
  maestroBin?: string
  /** Where a binary built elsewhere finds its drivers. */
  maestroHome?: string
  secretsFile?: string
  judgeBudgetUsd?: number
  sweepRef?: string
}

export function settingsPath(env = process.env): string {
  return (
    env.E2E_LOCAL_SETTINGS ??
    join(homedir(), '.config', 'teamstation-e2e', 'local.json')
  )
}

export function loadSettings(path = settingsPath()): LocalSettings {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as LocalSettings
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
