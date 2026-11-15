import { matchesAny } from './glob'
import type { Manifest, ManifestEntry } from './manifest'

/** The harness every scenario runs on: a change to it can break any of them. */
const HARNESS = ['e2e/core/**']

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
