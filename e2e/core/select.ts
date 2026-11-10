import { matchesAny } from './glob'
import type { Manifest, ManifestEntry } from './manifest'

/** Scenarios whose `covers` match any changed file. */
export function selectScenarios(
  manifest: Manifest,
  changed: string[]
): ManifestEntry[] {
  return manifest.scenarios.filter(entry =>
    changed.some(file => matchesAny(file, entry.covers))
  )
}
