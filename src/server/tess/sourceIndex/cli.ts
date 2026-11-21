import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isSourceTool, openSourceIndex, sourceIndexPath } from '../sourceTools'
import { buildSourceIndex } from './build'

export function sourceIndexCli(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      out: { type: 'string' },
      index: { type: 'string' }
    }
  })
  if (positionals[0] === 'call') {
    if (positionals.length !== 3 || !isSourceTool(positionals[1]))
      throw new Error(
        'Usage: tess.source-index call <source-tool> <json> [--index path]'
      )
    const result = openSourceIndex(values.index ?? sourceIndexPath()).run(
      positionals[1],
      JSON.parse(positionals[2])
    )
    console.log(JSON.stringify(result, null, 2))
    if (result.is_error === true) process.exitCode = 1
    return
  }
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
