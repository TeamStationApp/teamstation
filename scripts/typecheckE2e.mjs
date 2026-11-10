import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Typechecks `e2e/`, which needs the browser's types for code that runs in a page, and
 * reaches into `src` for what its rigs share with the server. Under those types a
 * server timer reads as a number, so `src` would report errors it does not have. Its
 * own projects check `src` with the right types, so this one answers only for `e2e/`.
 */
export function e2eErrors(output) {
  const blocks = []
  let keeping = false
  for (const line of output.split('\n')) {
    const error = /^([^\s(]+)\(\d+,\d+\): error /.exec(line)
    if (error != null) {
      keeping = error[1].startsWith('e2e/')
      if (keeping) blocks.push(line)
    } else if (keeping && line.startsWith(' ')) {
      blocks[blocks.length - 1] += `\n${line}`
    } else {
      keeping = false
    }
  }
  return blocks
}

function main() {
  const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.e2e.json'], {
    encoding: 'utf8'
  })
  const errors = e2eErrors(tsc.stdout)
  for (const error of errors) console.error(error)
  // A failure that names no file, such as a bad configuration, is still a failure.
  const unexplained = tsc.status !== 0 && !/\): error /.test(tsc.stdout)
  if (unexplained) console.error(tsc.stdout, tsc.stderr)
  process.exit(errors.length > 0 || unexplained ? 1 : 0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
