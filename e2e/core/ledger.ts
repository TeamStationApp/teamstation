import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { LocalSettings } from './settings'

/** One line per run or fault proof, kept on the machine that ran them. */
export interface DetectRow {
  kind: 'detect'
  at: string
  scenario: string
  surface: string
  fault: string
  ref: string
  caught: boolean
  caughtBy: string
  /** The layer that caught it is one the catalogue expects. */
  expectedLayer: boolean
  status: string
}

export type LedgerRow = DetectRow

export function ledgerPath(settings: LocalSettings, override?: string): string {
  return (
    override ??
    settings.ledger ??
    join(homedir(), '.config', 'teamstation-e2e', 'ledger.jsonl')
  )
}

export function appendLedger(path: string, row: LedgerRow): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(row)}\n`)
}

export function readLedger(path: string): LedgerRow[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as LedgerRow)
}
