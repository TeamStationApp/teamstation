import { matchesAny } from './glob'
import type { Manifest, ManifestEntry } from './manifest'

/**
 * The harness every scenario runs on: a change to it can break any of them.
 * Its faults, its shared rigs and the fixture worlds are part of it; a
 * module's own rigs are in that module's scenarios' `covers`.
 */
const HARNESS = [
  'e2e/core/**',
  'e2e/faults/**',
  'e2e/rigs/*.ts',
  'src/server/dev/fixtures/**'
]

/**
 * Scenarios whose `covers` match any changed file, or whose own spec file
 * changed; every scenario when the harness changed.
 */
export function selectScenarios(
  manifest: Manifest,
  changed: string[]
): ManifestEntry[] {
  if (changed.some(file => matchesAny(file, HARNESS))) {
    return manifest.scenarios
  }
  return manifest.scenarios.filter(entry =>
    changed.some(file => file === entry.file || matchesAny(file, entry.covers))
  )
}
