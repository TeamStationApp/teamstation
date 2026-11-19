import { join } from 'node:path'

import {
  type EngineBuild,
  type EngineHandle,
  type EngineRequest,
  type EngineSession,
  runBuild
} from './wire'

export * from './wire'

/**
 * The Auto-Scheduler's C++ engine in Node — the tests and the scripts: the
 * Node-API addon `scripts/schedulerBuild.mjs node` builds, running each
 * build on a libuv worker so the event loop stays free. The web
 * (`engine.web.ts`) and the phones (`engine.native.ts`) have their own.
 *
 * `TS_SCHEDULER_ADDON` names another build of the addon (the coverage
 * run's); otherwise it is `node/scheduler.node` next to this file.
 */

/** The addon: `build(request, onProgress)` starts a build on a worker. */
export interface Addon {
  build: (request: string, onProgress?: (event: string) => void) => EngineHandle
}

declare const TS_SCHEDULER_NODE_ADDON: string | undefined

export function addonPath(): string {
  const override = process.env.TS_SCHEDULER_ADDON
  if (override != null && override !== '') return override
  return typeof TS_SCHEDULER_NODE_ADDON === 'string'
    ? TS_SCHEDULER_NODE_ADDON
    : join(__dirname, 'node', 'scheduler.node')
}

/** The addon, or the error that says how to build it. */
export function loadAddon(
  path: string = addonPath(),
  load: (path: string) => unknown = require
): Addon {
  try {
    return load(path) as Addon
  } catch (caught: unknown) {
    const why = caught instanceof Error ? caught.message : String(caught)
    throw new Error(
      `The scheduler addon is missing or broken (${path}): run node scripts/schedulerBuild.mjs node. ${why}`
    )
  }
}

let loaded: Addon | undefined

/**
 * Builds a run's schedule options with the C++ engine, on a libuv worker so
 * the event loop stays free: up to three options, the recommended one
 * first; the blocking cause when no new game fits; or a typed failure.
 * The session's abort cancels the build.
 */
export async function buildSchedule(
  request: EngineRequest,
  session?: EngineSession,
  addon?: Addon
): Promise<EngineBuild> {
  const engine = addon ?? (loaded ??= loadAddon())
  return await runBuild(
    (text, onProgress) => engine.build(text, onProgress),
    request,
    session
  )
}
