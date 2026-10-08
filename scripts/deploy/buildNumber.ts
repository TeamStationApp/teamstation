import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { asArray, asObject } from 'cleaners'

import { noSymlinks } from './state'
import { branchName, integer, object, text } from './validation'

const asEntries = asArray(
  object({
    branch: branchName,
    lastBuildDate: (value: unknown): string => {
      const date = text()(value)
      if (new Date(date).toISOString() !== date)
        throw new Error('Invalid build date')
      return date
    },
    buildNumber: integer(0, 99999999)
  })
)

export function packageVersion(source: string): string {
  const { version } = asObject({ version: text(80) })(
    JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
  )
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Package version must contain three numeric components')
  return version
}

/** Intentionally unlocked: concurrent invocations may allocate the same number. */
export function allocateBuildNumber(
  file: string,
  source: string,
  branch: string,
  now = new Date()
): number {
  branchName(branch)
  const year = now.getFullYear()
  if (year < 2000 || year > 2099) throw new Error('Unsupported build year')
  const prefix =
    (year % 100) * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
  const snapshot = path.join(source, 'buildNum.json')
  noSymlinks(file)
  noSymlinks(snapshot)
  // Keep the snapshot untracked even when building an older source branch.
  const ignore = path.join(source, '.gitignore')
  noSymlinks(ignore)
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  if (!ignored.split('\n').includes('/buildNum.json'))
    writeFileSync(ignore, ignored + '\n/buildNum.json\n')
  const entries = existsSync(file)
    ? asEntries(JSON.parse(readFileSync(file, 'utf8')))
    : []
  if (new Set(entries.map(entry => entry.branch)).size !== entries.length)
    throw new Error('Duplicate build counter branch')
  const previous = entries.find(entry => entry.branch === branch)
  const counter =
    previous != null && Math.floor(previous.buildNumber / 100) === prefix
      ? (previous.buildNumber % 100) + 1
      : 0
  if (counter > 99) throw new Error('maximum build number reached')
  const buildNumber = prefix * 100 + counter
  const next = { branch, lastBuildDate: now.toISOString(), buildNumber }
  const content =
    JSON.stringify(
      [...entries.filter(entry => entry.branch !== branch), next],
      null,
      2
    ) + '\n'
  // Atomic replacement avoids partially written JSON without serializing allocators.
  const temporary = `${file}.${randomBytes(8).toString('hex')}`
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, file)
  writeFileSync(snapshot, content, { mode: 0o600 })
  return buildNumber
}
