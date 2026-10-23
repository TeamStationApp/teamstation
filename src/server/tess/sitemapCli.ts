import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import {
  generateSitemap,
  type Sitemap,
  sitemapDifference,
  sitemapText
} from './sitemapGenerator'

/**
 * Writes Tess's sitemap from the code, or checks the checked-in one.
 *
 *   npm run tess.sitemap
 *   npm run tess.sitemap -- --check
 *   npm run tess.sitemap -- --check --file <path>
 *
 * `--check` writes nothing: it exits 0 when the file is what the code gives,
 * and 1 with the first route that differs when it is stale. `--file` reads or
 * writes another copy, for checking one without touching the real file.
 */

export const SITEMAP_FILE = resolve(__dirname, 'sitemap.generated.json')

export interface SitemapCliIo {
  print: (line: string) => void
  generate?: () => Sitemap
}

/** Runs the command line with `args`; the exit code. */
export function runSitemapCli(args: string[], io: SitemapCliIo): number {
  let check = false
  let file = SITEMAP_FILE
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check') check = true
    else if (args[index] === '--file' && args[index + 1] != null) {
      index += 1
      file = resolve(args[index])
    } else {
      io.print(`Unknown argument ${args[index]}`)
      io.print('Usage: tess.sitemap [--check] [--file <path>]')
      return 2
    }
  }

  const sitemap = (io.generate ?? generateSitemap)()
  const text = sitemapText(sitemap)
  const count = `${sitemap.routes.length} routes`
  const name = relative(process.cwd(), file)
  if (!check) {
    writeFileSync(file, text)
    io.print(`Wrote ${name}: ${count}, ${Buffer.byteLength(text)} bytes`)
    return 0
  }

  let stored: string
  try {
    stored = readFileSync(file, 'utf8')
  } catch {
    io.print(`${name} is missing: run npm run tess.sitemap`)
    return 1
  }
  const difference = sitemapDifference(sitemap, stored)
  if (difference == null) {
    io.print(`${name} is up to date: ${count}`)
    return 0
  }
  io.print(`${name} is stale: ${difference}. Run npm run tess.sitemap`)
  return 1
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/sitemapCli.ts') || entry.endsWith('/sitemapCli.js')) {
  process.exitCode = runSitemapCli(process.argv.slice(2), {
    print: line => {
      console.log(line)
    }
  })
}
