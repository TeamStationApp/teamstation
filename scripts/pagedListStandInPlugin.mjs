// An esbuild plugin for bundles that run in Node (the bundled app tests).
// Their DOM has no layout, so Legend List would have no length to draw for
// and no rows, and a suite reads rows well past any draw distance: an import
// of `PagedList` resolves to the stand-in, `src/test/PagedListStandIn.tsx`,
// which draws them all.
//
// `PagedList.test.tsx` and `PagedList.native.test.tsx` import the real files
// by their full names, `./PagedList.tsx` and `./PagedList.native.tsx`, which
// this leaves alone. The second also gets the phone's Legend List rather than
// the browser's, which its package would hand a bundle.
import { resolve } from 'node:path'

/** The stand-in for an import of `PagedList`, undefined for anything else. */
export function resolvePagedList(resolveDir, importPath, root = process.cwd()) {
  const list = resolve(root, 'src', 'app', 'components', 'PagedList')
  return resolve(resolveDir, importPath) === list
    ? resolve(root, 'src', 'test', 'PagedListStandIn.tsx')
    : undefined
}

/** Legend List's phone build for its import in the phone's `PagedList`. */
export function resolvePhoneLegend(importer, root = process.cwd()) {
  return importer ===
    resolve(root, 'src', 'app', 'components', 'PagedList.native.tsx')
    ? resolve(root, 'node_modules', '@legendapp', 'list', 'react-native.js')
    : undefined
}

export function pagedListStandInPlugin(root = process.cwd()) {
  return {
    name: 'paged-list-stand-in',
    setup(build) {
      build.onResolve({ filter: /(^|\/)PagedList$/ }, args => {
        const path = resolvePagedList(args.resolveDir, args.path, root)
        return path == null ? undefined : { path }
      })
      build.onResolve({ filter: /^@legendapp\/list\/react-native$/ }, args => {
        const path = resolvePhoneLegend(args.importer, root)
        return path == null ? undefined : { path }
      })
    }
  }
}
