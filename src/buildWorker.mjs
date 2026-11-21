import { relative } from 'node:path'

/** Where the password worker is written: with the page, wherever that is. */
export function workerOutDir(env = process.env) {
  return env.TS_WEB_OUT_DIR ?? 'dist'
}

/** The URL the page asks for the worker at, from the file the build wrote. */
export function workerUrl(workerFile, outDir) {
  return '/' + relative(outDir, workerFile).split('\\').join('/')
}
