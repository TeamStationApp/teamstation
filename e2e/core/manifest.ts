import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { HarnessError } from './result'
import type { E2eSpec, Surface, SurfaceNeeds } from './spec'

export const ROOT = resolve(__dirname, '..', '..')
const MANIFEST = join(ROOT, 'e2e', 'manifest.json')

export interface ManifestEntry {
  /** `category/feature/behaviour#scenario`, what `run` is given. */
  id: string
  spec: string
  file: string
  title: string
  kind: string
  covers: string[]
  stack: string
  fixtures: string[]
  exclusive: boolean
  surfaces: Partial<Record<Surface, SurfaceNeeds>>
  services: string[]
  apps: string[]
  secrets: string[]
  costUsd: number
  minutes: number
  guards: string[]
  faults: string[]
  manual: boolean
  quarantine?: { reason: string; since: string; scenarios?: string[] }
}

export interface Manifest {
  scenarios: ManifestEntry[]
}

export function testFiles(root = ROOT): string[] {
  return globSync(
    [
      'e2e/tests/**/*.e2e.ts',
      'e2e/tests/**/*.e2e.tsx',
      'e2e/tests/**/*.integration.ts'
    ],
    { cwd: root }
  ).sort()
}

export function loadSpec(file: string, root = ROOT): E2eSpec {
  const loaded = require(join(root, file)) as { default?: E2eSpec }
  if (loaded.default == null) {
    throw new HarnessError(`${file} does not default-export defineE2e`)
  }
  return loaded.default
}

export function buildManifest(root = ROOT): Manifest {
  const scenarios: ManifestEntry[] = []
  for (const file of testFiles(root)) {
    const spec = loadSpec(file, root)
    for (const name of Object.keys(spec.scenarios).sort()) {
      const { scenarios: _scenarios, ...rest } = spec
      scenarios.push({
        ...rest,
        id: `${spec.id}#${name}`,
        spec: spec.id,
        file: relative(root, join(root, file))
      })
    }
  }
  scenarios.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { scenarios }
}

export function renderManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function readManifest(path = MANIFEST): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

export function writeManifest(root = ROOT): Manifest {
  const manifest = buildManifest(root)
  writeFileSync(join(root, 'e2e', 'manifest.json'), renderManifest(manifest))
  return manifest
}

/** The spec and scenario a `category/feature/behaviour#scenario` id names. */
export function findScenario(
  id: string,
  root = ROOT
): { entry: ManifestEntry; spec: E2eSpec } {
  const entry = buildManifest(root).scenarios.find(row => row.id === id)
  if (entry == null) throw new HarnessError(`No scenario "${id}"`)
  return { entry, spec: loadSpec(entry.file, root) }
}
