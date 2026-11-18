import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildSourceIndex } from './build'

export function sourceIndexCli(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      out: { type: 'string' }
    }
  })
  if (positionals.length !== 1 || positionals[0] !== 'build')
    throw new Error(
      'Usage: tess.source-index build [--root .] [--out lib/server/tess/source.db]'
    )
  const root = resolve(values.root)
  console.log(
    JSON.stringify(
      buildSourceIndex({
        root,
        out: resolve(values.out ?? `${root}/lib/server/tess/source.db`)
      }),
      null,
      2
    )
  )
}

export function sourceIndexMain(args: string[]): void {
  try {
    sourceIndexCli(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) sourceIndexMain(process.argv.slice(2))
