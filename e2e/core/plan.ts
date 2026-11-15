import type { Manifest, ManifestEntry } from './manifest'
import { hasSecret, type LocalSettings } from './settings'
import { type DeviceNeed, SEAT_ONLY_SERVICES, type Surface } from './spec'

/** A lease resource as `list-resources` reports it. */
export interface PlanResource {
  available?: boolean
  capabilities?: string[]
  borrower?: string
  expiry?: string
}

export interface LedgerFacts {
  lastStatus?: string
  durationMs?: number
  flakeRate?: number
}

export interface PlanRow {
  id: string
  surface: Surface
  runnable: boolean
  blockedBy: string[]
  minutes: number
  costUsd: number
  exclusive: boolean
  devices: string[]
  ledger: LedgerFacts
}

export interface PlanInput {
  resources: Record<string, PlanResource>
  seat?: string
  settings: LocalSettings
  ledger?: Record<string, LedgerFacts>
}

function deviceBlock(
  need: DeviceNeed,
  resources: Record<string, PlanResource>
): string | undefined {
  // A task-owned Chromium or simulator takes no lease.
  if (need.hardware !== 'required') return undefined
  const matching = Object.entries(resources).filter(([, resource]) =>
    need.needs.every(
      capability => resource.capabilities?.includes(capability) === true
    )
  )
  if (matching.length === 0) {
    return `no device can be ${need.role}: needs ${need.needs.join(', ')}`
  }
  if (matching.some(([, resource]) => resource.available === true)) {
    return undefined
  }
  const [id, held] = matching[0]
  return `${need.role}: ${id} is held by ${held.borrower ?? 'someone'} until ${held.expiry ?? 'later'}`
}

function blocks(
  entry: ManifestEntry,
  surface: Surface,
  input: PlanInput
): string[] {
  const out: string[] = []
  if (entry.manual) out.push('manual: a person must act')
  for (const secret of entry.secrets) {
    if (!hasSecret(input.settings, secret)) out.push(`no secret "${secret}"`)
  }
  const onSeat = entry.stack === 'seat' && input.seat != null
  if (!onSeat) {
    for (const service of entry.services) {
      if (SEAT_ONLY_SERVICES.includes(service)) {
        out.push(`${service} needs a seat`)
      }
    }
  }
  for (const guard of entry.guards) out.push(`guard "${guard}" to check first`)
  for (const need of entry.surfaces[surface]?.devices ?? []) {
    const block = deviceBlock(need, input.resources)
    if (block != null) out.push(block)
  }
  return out
}

/** Marks each scenario on each surface runnable or not. It orders nothing. */
export function planScenarios(manifest: Manifest, input: PlanInput): PlanRow[] {
  const rows: PlanRow[] = []
  for (const entry of manifest.scenarios) {
    for (const surface of Object.keys(entry.surfaces) as Surface[]) {
      const blockedBy = blocks(entry, surface, input)
      rows.push({
        id: entry.id,
        surface,
        runnable: blockedBy.length === 0,
        blockedBy,
        minutes: entry.minutes,
        costUsd: entry.costUsd,
        exclusive: entry.exclusive,
        devices: (entry.surfaces[surface]?.devices ?? []).map(d => d.role),
        ledger: input.ledger?.[entry.id] ?? {}
      })
    }
  }
  return rows
}
