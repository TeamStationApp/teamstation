import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BlockedError, HarnessError } from './result'
import type { StackHandle } from './spec'

/**
 * A stack something else created, such as a throwaway droplet, described by a
 * versioned JSON handle. Later versions add fields; this reader keeps every
 * field it does not know, so their readers find them in `handle`.
 */
export interface AttachedHandle {
  version: number
  id: string
  /** Where a browser opens the app. */
  origin: string
  /** The API's base, when it is not under the origin. */
  api?: string
  [field: string]: unknown
}

/** What the registry holds for one stack, whether `stack up` or `attach` made it. */
export interface StackEntry {
  id: string
  origin: string
  webDir?: string
  /** The process serving a `stack up` stack; an attached stack has none. */
  pid?: number
  /** The handle an attached stack was registered from. */
  handle?: AttachedHandle
  handleFile?: string
}

/** Where `stack up` and `stack attach` register stacks. */
export const STACKS = join(tmpdir(), 'teamstation-e2e-stacks')

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Reads a handle, or says what is wrong with it as a harness error. */
export function parseHandle(text: string, file: string): AttachedHandle {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HarnessError(`${file} is not JSON`)
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError(`${file} is not a stack handle object`)
  }
  const handle = value as Record<string, unknown>
  if (typeof handle.version !== 'number' || handle.version < 1) {
    throw new HarnessError(`${file} has no handle version`)
  }
  if (typeof handle.id !== 'string' || !ID.test(handle.id)) {
    throw new HarnessError(`${file} has no stack id of a-z, 0-9 and -`)
  }
  for (const name of ['origin', 'api']) {
    const url = handle[name]
    if (url == null && name === 'api') continue
    if (typeof url !== 'string' || !/^https?:\/\/[^/]/.test(url)) {
      throw new HarnessError(`${file} has no ${name} URL`)
    }
  }
  return handle as AttachedHandle
}

/** Registers the stack a handle file describes, replacing an earlier attach of it. */
export function attachStack(dir: string, file: string): StackEntry {
  const handleFile = resolve(file)
  if (!existsSync(handleFile)) throw new HarnessError(`No handle ${file}`)
  const handle = parseHandle(readFileSync(handleFile, 'utf8'), file)
  const entryFile = join(dir, `${handle.id}.json`)
  if (existsSync(entryFile) && readStack(dir, handle.id).handle == null) {
    throw new HarnessError(`Stack "${handle.id}" is a running stack up stack`)
  }
  const entry: StackEntry = {
    id: handle.id,
    origin: handle.origin.replace(/\/$/, ''),
    handle,
    handleFile
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(entryFile, JSON.stringify(entry, null, 2))
  return entry
}

export function readStack(dir: string, id: string): StackEntry {
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) throw new Error(`No stack "${id}"`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listStacks(dir: string): StackEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => readStack(dir, name.slice(0, -'.json'.length)))
}

/** Forgets a stack; a `stack up` one is stopped first, an attached one is left running. */
export function removeStack(
  dir: string,
  id: string,
  kill: (pid: number) => void
): { id: string; stopped: boolean } {
  const entry = readStack(dir, id)
  if (entry.handle == null && entry.pid != null) kill(entry.pid)
  rmSync(join(dir, `${id}.json`))
  return { id, stopped: entry.handle == null }
}

/** The handle a scenario gets for a registered stack. */
export function stackHandleFor(entry: StackEntry): StackHandle {
  return {
    kind: 'isolated',
    origin: entry.origin,
    webDir: entry.webDir,
    attached: entry.handle,
    adopt: async origin => origin,
    serverErrors: async () => undefined
  }
}

/** Fault runs need the suite's own proxy in front of the server, which an attached stack lacks. */
export function refuseAttachedForFaults(entry: StackEntry): void {
  if (entry.handle != null) {
    throw new BlockedError(
      `stack "${entry.id}" is attached: it has no fault proxy, so faults cannot be proven on it`
    )
  }
}
