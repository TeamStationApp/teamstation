import { FAULTS } from '../faults/catalogue'
import type { DetectRow } from './ledger'

/** How much of each category's faults its tests were last seen to catch. */
export interface FaultStanding {
  fault: string
  caught: boolean
  caughtBy: string
  scenario: string
  at: string
  ageDays: number
}

export interface CategoryScore {
  category: string
  caught: number
  proven: number
  /** Share of the proven faults caught. */
  rate: number
  layers: Record<string, number>
  survivors: string[]
  faults: FaultStanding[]
}

export interface Scorecard {
  categories: CategoryScore[]
  layers: Record<string, number>
  caught: number
  proven: number
  rate: number
}

function dayGap(from: string, now: number): number {
  return Math.floor((now - Date.parse(from)) / 86_400_000)
}

/**
 * The latest proof of each fault in each category. A fault is caught in a category
 * when any of its scenarios caught it on its latest run.
 */
export function buildScorecard(rows: DetectRow[], now = Date.now()): Scorecard {
  const latest = new Map<string, DetectRow>()
  for (const row of rows) {
    if (FAULTS[row.fault] == null) continue
    const key = `${row.scenario}|${row.surface}|${row.fault}`
    const seen = latest.get(key)
    if (seen == null || seen.at <= row.at) latest.set(key, row)
  }
  const byCategory = new Map<string, Map<string, DetectRow>>()
  for (const row of latest.values()) {
    const category = row.scenario.split('/')[0]
    let faults = byCategory.get(category)
    if (faults == null) {
      faults = new Map()
      byCategory.set(category, faults)
    }
    const held = faults.get(row.fault)
    const better =
      held == null ||
      (row.caught && !held.caught) ||
      (row.caught === held.caught && held.at <= row.at)
    if (better) faults.set(row.fault, row)
  }
  const layers: Record<string, number> = {}
  const categories = [...byCategory.entries()]
    .map(([category, faults]): CategoryScore => {
      const standings = [...faults.values()].map(row => ({
        fault: row.fault,
        caught: row.caught,
        caughtBy: row.caughtBy,
        scenario: row.scenario,
        at: row.at,
        ageDays: dayGap(row.at, now)
      }))
      const caught = standings.filter(row => row.caught)
      const own: Record<string, number> = {}
      for (const row of caught) {
        own[row.caughtBy] = (own[row.caughtBy] ?? 0) + 1
        layers[row.caughtBy] = (layers[row.caughtBy] ?? 0) + 1
      }
      return {
        category,
        caught: caught.length,
        proven: standings.length,
        rate: standings.length === 0 ? 0 : caught.length / standings.length,
        layers: own,
        survivors: standings.filter(row => !row.caught).map(row => row.fault),
        faults: standings
      }
    })
    .sort((a, b) => (a.category < b.category ? -1 : 1))
  const caught = categories.reduce((sum, row) => sum + row.caught, 0)
  const proven = categories.reduce((sum, row) => sum + row.proven, 0)
  return {
    categories,
    layers,
    caught,
    proven,
    rate: proven === 0 ? 0 : caught / proven
  }
}
