import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  asUnknown
} from 'cleaners'

import {
  appId,
  branchName,
  integer,
  object,
  platform,
  sha,
  text
} from './validation'

export function noSymlinks(file: string): void {
  let current = path.resolve(file)
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('Deployment state cannot use symlinks')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}
export function ownedDirectory(directory: string, kind: string): string {
  noSymlinks(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const marker = path.join(directory, '.teamstation-deploy')
  if (!existsSync(marker)) {
    // Creating a marker never authorizes recursive deletion of this directory.
    writeFileSync(marker, JSON.stringify({ version: 1, kind }), {
      flag: 'wx',
      mode: 0o600
    })
  }
  noSymlinks(marker)
  const data = asObject({ version: integer(1, 1), kind: asString })(
    JSON.parse(readFileSync(marker, 'utf8'))
  )
  if (data.kind !== kind)
    throw new Error('Directory belongs to another deployment purpose')
  return realpathSync(directory)
}
export const runId = (value: unknown): string => {
  const out = text(32)(value)
  if (!/^[a-f0-9]{32}$/.test(out)) throw new Error('Invalid run ID')
  return out
}
const digest = (value: unknown): string => {
  const out = text(64)(value)
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error('Invalid digest')
  return out
}
/** An iOS run's App Store IPA, published to TestFlight after the ad-hoc one. */
const asStorePackage = object({
  file: text(256),
  digest,
  size: integer(1),
  published: asOptional(asBoolean)
})
const asArtifact = object({
  platform,
  file: text(256),
  digest,
  size: integer(1),
  buildNumber: integer(1, 2100000000),
  version: text(80),
  published: asOptional(integer(1)),
  error: asOptional(text(256)),
  testflight: asOptional(asStorePackage)
})
export const asRun = object({
  id: runId,
  app: appId,
  branch: branchName,
  commit: sha,
  createdAt: integer(),
  version: text(80),
  buildNumberFormat: asOptional((value: unknown): 'date' => {
    if (value !== 'date') throw new Error('Invalid build number format')
    return value
  }),
  platforms: asArray(platform),
  artifacts: asArray(asArtifact),
  failed: asArray(platform)
})
export type Run = ReturnType<typeof asRun>
export type Artifact = ReturnType<typeof asArtifact>
export class State {
  readonly db: DatabaseSync
  private readonly lock: DatabaseSync
  readonly directory: string
  constructor(directory: string) {
    this.directory = ownedDirectory(directory, 'state')
    const file = path.join(this.directory, 'numbers.sqlite')
    const lockFile = path.join(this.directory, 'lock.sqlite')
    for (const name of [file, lockFile])
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        noSymlinks(name + suffix)
    this.lock = new DatabaseSync(lockFile, { timeout: 0 })
    chmodSync(lockFile, 0o600)
    try {
      this.lock.exec('BEGIN EXCLUSIVE')
    } catch {
      this.lock.close()
      throw new Error('Another deployment is running')
    }
    try {
      this.db = new DatabaseSync(file, { timeout: 5000 })
      chmodSync(file, 0o600)
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS counters(app TEXT NOT NULL, platform TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(app,platform)) STRICT; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;'
      )
    } catch (error) {
      this.lock.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
    this.lock.close()
  }

  reserve(app: string, os: string, seed: number): number {
    appId(app)
    platform(os)
    integer(1, 2100000000)(seed)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT value FROM counters WHERE app=? AND platform=?')
        .get(app, os)
      const number =
        row == null
          ? seed
          : Math.max(
              seed,
              asObject({ value: integer(1, 2100000000) })(row).value + 1
            )
      integer(1, 2100000000)(number)
      this.db
        .prepare(
          'INSERT INTO counters VALUES(?,?,?) ON CONFLICT(app,platform) DO UPDATE SET value=excluded.value'
        )
        .run(app, os, number)
      this.db.exec('COMMIT')
      return number
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  save(value: unknown): Run {
    const run = asRun(value)
    for (const artifact of run.artifacts)
      for (const file of [artifact.file, artifact.testflight?.file])
        if (
          file != null &&
          (path.basename(file) !== file || file === '.' || file === '..')
        )
          throw new Error('Invalid artifact filename')
    this.db
      .prepare(
        'INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(run.id, JSON.stringify(run))
    return run
  }

  load(id: string): Run {
    const row = asObject({ data: asString })(
      this.db.prepare('SELECT data FROM runs WHERE id=?').get(runId(id))
    )
    return asRun(JSON.parse(row.data))
  }

  prune(output: string, now = Date.now()): void {
    output = ownedDirectory(output, 'output')
    for (const raw of this.db.prepare('SELECT data FROM runs').all()) {
      const run = asRun(JSON.parse(asObject({ data: asString })(raw).data))
      if (now - run.createdAt > 48 * 3600000) {
        const directory = path.join(output, run.id)
        noSymlinks(directory)
        if (existsSync(directory)) {
          const marker = path.join(directory, '.run')
          noSymlinks(marker)
          if (
            asObject({ id: runId })(JSON.parse(readFileSync(marker, 'utf8')))
              .id !== run.id
          )
            throw new Error('Unowned output directory')
          rmSync(directory, { recursive: true })
        }
      }
      if (now - run.createdAt > 14 * 86400000)
        this.db.prepare('DELETE FROM runs WHERE id=?').run(run.id)
    }
  }
}
export function createOutput(
  parent: string,
  id = randomBytes(16).toString('hex')
): string {
  parent = ownedDirectory(parent, 'output')
  runId(id)
  const out = path.join(parent, id)
  noSymlinks(out)
  mkdirSync(out, { mode: 0o700 })
  writeFileSync(path.join(out, '.run'), JSON.stringify({ id }), {
    flag: 'wx',
    mode: 0o600
  })
  return out
}
export function atomicJson(file: string, value: unknown): void {
  noSymlinks(file)
  const temporary = file + '.' + randomBytes(16).toString('hex')
  try {
    writeFileSync(temporary, JSON.stringify(asUnknown(value)), {
      flag: 'wx',
      mode: 0o600
    })
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}
