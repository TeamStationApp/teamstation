// An esbuild plugin for the native specs' bundles: inside `src/app/sponsors/`
// a relative import resolves to its `.native.tsx` / `.native.ts` twin when
// there is one, as Metro resolves it on a phone. So a native spec renders
// the real sponsor screens with the phones' file chooser, sample video,
// reel preview, date picker and shrinking. Other directories keep the web
// build's resolution, as the native specs have always had.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SPONSORS = resolve('src/app/sponsors')

export function sponsorNativePlugin() {
  return {
    name: 'sponsor-native-twins',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, args => {
        if (!args.importer.startsWith(SPONSORS + '/')) return undefined
        if (/\.native(\.[tj]sx?)?$/.test(args.path)) return undefined
        const base = resolve(dirname(args.importer), args.path)
        if (!base.startsWith(SPONSORS + '/')) return undefined
        for (const extension of ['.native.tsx', '.native.ts']) {
          const twin = base + extension
          if (existsSync(twin)) return { path: twin }
        }
        return undefined
      })
    }
  }
}
