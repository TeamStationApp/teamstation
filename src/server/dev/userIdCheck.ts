import { readFile, writeFile } from 'node:fs/promises'

import { Pool } from 'pg'

import { compareUserIds } from './userIdCompare'
import {
  canonical,
  captureUserIds,
  type Json,
  type UserIdSnapshot
} from './userIdSnapshot'

function option(args: string[], key: string): string {
  const at = args.indexOf(key)
  if (at < 0 || args[at + 1] == null || args[at + 1].startsWith('--')) {
    throw new Error(`Missing ${key}`)
  }
  return args[at + 1]
}

export async function runUserIdCheck(
  args: string[],
  print: (line: string) => void
): Promise<number> {
  if (args[0] === 'snapshot') {
    const database = option(args, '--database')
    const origin = option(args, '--api')
    const out = option(args, '--out')
    const pool = new Pool({ connectionString: database })
    try {
      const snapshot = await captureUserIds(pool, origin)
      await writeFile(out, canonical(snapshot as unknown as Json) + '\n', {
        mode: 0o600,
        flag: 'wx'
      })
      print(
        '$ userIdCheck snapshot --database [redacted] --api [origin] --out [private snapshot]'
      )
      for (const [table, data] of Object.entries(snapshot.tables))
        print(`sql.${table}: ${data.rows.length}`)
      print(`api: ${Object.keys(snapshot.api).length}`)
      return 0
    } finally {
      await pool.end()
    }
  }
  if (args[0] === 'compare') {
    if (args[1] == null || args[2] == null)
      throw new Error('Expected two snapshot paths')
    const out = option(args, '--out')
    if (args.some(arg => arg.startsWith('--allow-')))
      throw new Error('Requested transformation adapter is not installed')
    const before = JSON.parse(await readFile(args[1], 'utf8')) as UserIdSnapshot
    const after = JSON.parse(await readFile(args[2], 'utf8')) as UserIdSnapshot
    const result = compareUserIds(before, after)
    const lines = ['$ userIdCheck compare [before] [after] --out [report]']
    for (const [key, count] of Object.entries(result.counts))
      lines.push(`${key}: ${count.before} -> ${count.after}`)
    lines.push(`${result.differenceCount} differences`, ...result.differences)
    await writeFile(out, lines.join('\n') + '\n', { mode: 0o600 })
    for (const line of lines) print(line)
    return result.equal ? 0 : 1
  }
  throw new Error('Expected snapshot or compare')
}

const entry = process.argv[1] ?? ''
if (/\/userIdCheck\.(ts|js)$/.test(entry)) {
  runUserIdCheck(process.argv.slice(2), line => {
    console.log(line)
  })
    .then(code => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : 'Identity check failed'
      )
      process.exitCode = 1
    })
}
