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
  out.push(
    ...devicesBlock(entry.surfaces[surface]?.devices ?? [], input.resources)
  )
  return out
}

/**
 * What stops a scenario's roles getting their devices: each on its own, then
 * all together, since two roles that need the same kind of phone need two
 * phones. Free devices are matched to roles one each, so a role is short
 * only when no rearrangement gives it one.
 */
function devicesBlock(
  needs: DeviceNeed[],
  resources: Record<string, PlanResource>
): string[] {
  const alone = needs
    .map(need => deviceBlock(need, resources))
    .filter((block): block is string => block != null)
  if (alone.length > 0) return alone
  const required = needs.filter(need => need.hardware === 'required')
  const free = (need: DeviceNeed): string[] =>
    Object.entries(resources)
      .filter(
        ([, resource]) =>
          resource.available === true &&
          need.needs.every(
            capability => resource.capabilities?.includes(capability) === true
          )
      )
      .map(([id]) => id)
  // Which role each free device is matched to, by the role's index.
  const holder = new Map<string, number>()
  const match = (role: number, tried: Set<string>): boolean => {
    for (const id of free(required[role])) {
      if (tried.has(id)) continue
      tried.add(id)
      const other = holder.get(id)
      if (other == null || match(other, tried)) {
        holder.set(id, role)
        return true
      }
    }
    return false
  }
  const short = required.filter((_, role) => !match(role, new Set()))
  if (short.length === 0) return []
  return [
    `not enough free devices for a device each: ${short
      .map(need => `${need.role} (${need.needs.join(', ')})`)
      .join(', ')} left without one`
  ]
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
