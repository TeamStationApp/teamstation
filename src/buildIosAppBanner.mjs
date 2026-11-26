import fs from 'node:fs/promises'
import path from 'node:path'

import { build, context } from 'esbuild'

import { finishAppBannerScript, withIntegrity } from './buildCsp.mjs'

/** The parser-blocking head tag, pointing at the same API as the application. */
export async function buildIosAppBanner(out, serve, apiBaseUrl) {
  const options = {
    entryPoints: ['src/app/web/iosAppBanner.ts'],
    entryNames: serve ? 'ios-app-banner' : 'app-ios-app-banner-[hash]',
    outdir: out,
    bundle: true,
    format: 'iife',
    target: 'es2021',
    minify: !serve,
    define: { TS_API_BASE_URL: JSON.stringify(apiBaseUrl) },
    sourcemap: true,
    metafile: true
  }
  let result
  if (serve) {
    // The watcher's first build is this one; `build` too would write it twice.
    const watcher = await context(options)
    result = await watcher.rebuild()
    await watcher.watch()
  } else result = await build(options)
  const file = Object.keys(result.metafile.outputs).find(name =>
    name.endsWith('.js')
  )
  const name = path.basename(file)
  const tag = `<script src="/${name}"></script>`
  const script = serve
    ? tag
    : withIntegrity(tag, { [`/${name}`]: await fs.readFile(file) })
  return { name, tag: `${script}<script>${finishAppBannerScript}</script>` }
}
