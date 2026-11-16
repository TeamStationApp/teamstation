import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { dropletStackHandle } from './dropletStack'
import { HarnessError } from './result'
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

/** What the registry holds for one stack: the handle it was attached from. */
export interface StackEntry {
  id: string
  origin: string
  handle?: AttachedHandle
  handleFile?: string
  /** Where its `baseline` manifest is, mode 0600, once seeded. */
  baselineManifest?: string
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
  const entry: StackEntry = {
    id: handle.id,
    origin: handle.origin.replace(/\/$/, ''),
    handle,
    handleFile
  }
  writeStackEntry(dir, entryFile, JSON.stringify(entry, null, 2))
  return entry
}

/**
 * Writes a stack's entry where only this user can read it: an attached
 * stack's handle carries its database URL, password and all, and the
 * registry lives under the shared temporary directory.
 */
export function writeStackEntry(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // Written beside it and renamed into place, so a reader polling for the
  // entry finds the whole of it or none of it.
  const part = `${file}.${process.pid}.part`
  writeFileSync(part, text, { mode: 0o600 })
  chmodSync(part, 0o600)
  renameSync(part, file)
}

/** Refuses an id other than a stack handle's (a-z, 0-9 and -): the id names files. */
export function checkStackId(id: string): string {
  if (!ID.test(id)) {
    throw new HarnessError(`Stack id "${id}" is not a-z, 0-9 and -`)
  }
  return id
}

export function readStack(dir: string, id: string): StackEntry {
  const file = join(dir, `${checkStackId(id)}.json`)
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

/** Where a stack's `baseline` manifest is kept, beside its entry (not a `.json`, so no entry). */
export const baselineFile = (dir: string, id: string): string =>
  join(dir, `${checkStackId(id)}.baseline`)

/** Forgets a stack: its entry and its baseline manifest. The stack itself is the provider's to stop. */
export function forgetStack(dir: string, id: string): void {
  rmSync(join(dir, `${checkStackId(id)}.json`), { force: true })
  rmSync(baselineFile(dir, id), { force: true })
}

/** The handle a scenario gets for a registered stack: a droplet's. */
export function stackHandleFor(
  entry: StackEntry,
  mailbox?: string
): StackHandle {
  return dropletStackHandle(entry, { mailbox })
}
