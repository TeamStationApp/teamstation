import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  pagedListStandInPlugin,
  resolvePagedList,
  resolvePhoneLegend
}: {
  pagedListStandInPlugin: (root?: string) => {
    name: string
    setup: (build: {
      onResolve: (
        options: { filter: RegExp },
        callback: (args: {
          path: string
          resolveDir: string
          importer: string
        }) => unknown
      ) => void
    }) => void
  }
  resolvePagedList: (
    resolveDir: string,
    importPath: string,
    root?: string
  ) => string | undefined
  resolvePhoneLegend: (importer: string, root?: string) => string | undefined
} = require('../../scripts/pagedListStandInPlugin.mjs')

/**
 * `scripts/pagedListStandInPlugin.mjs`: the bundled app tests have no layout,
 * so `PagedList` resolves to a stand-in that draws every row, except for the
 * suites of the real files, which name them in full.
 */
describe('the paged list stand-in plugin', function () {
  const root = '/repo'
  const components = join(root, 'src/app/components')
  const standIn = join(root, 'src/test/PagedListStandIn.tsx')

  it('gives every import of PagedList the stand-in', function () {
    expect(resolvePagedList(components, './PagedList', root)).equals(standIn)
    expect(
      resolvePagedList(
        join(root, 'src/app/screens'),
        '../components/PagedList',
        root
      )
    ).equals(standIn)
  })

  it('leaves the real files, named in full, alone', function () {
    for (const name of [
      './PagedList.tsx',
      './PagedList.native',
      './PagedList.native.tsx'
    ])
      expect(resolvePagedList(components, name, root)).equals(undefined)
  })

  it('leaves another PagedList alone', function () {
    expect(
      resolvePagedList(join(root, 'src/app/hooks'), './PagedList', root)
    ).equals(undefined)
  })

  it('gives the phone’s list the phone’s Legend List, and nothing else', function () {
    expect(
      resolvePhoneLegend(join(components, 'PagedList.native.tsx'), root)
    ).equals(join(root, 'node_modules/@legendapp/list/react-native.js'))
    expect(resolvePhoneLegend(join(components, 'PagedList.tsx'), root)).equals(
      undefined
    )
  })

  it('hooks both resolutions into a build', function () {
    const hooks: Array<{
      filter: RegExp
      callback: (args: {
        path: string
        resolveDir: string
        importer: string
      }) => unknown
    }> = []
    pagedListStandInPlugin(root).setup({
      onResolve: (options, callback) => {
        hooks.push({ filter: options.filter, callback })
      }
    })
    const resolved = (path: string, importer: string): unknown =>
      hooks
        .find(hook => hook.filter.test(path))
        ?.callback({ path, resolveDir: components, importer })
    expect(resolved('./PagedList', '')).deep.equals({ path: standIn })
    expect(resolved('./Other/PagedList', '')).equals(undefined)
    expect(
      resolved(
        '@legendapp/list/react-native',
        join(components, 'PagedList.native.tsx')
      )
    ).deep.equals({
      path: join(root, 'node_modules/@legendapp/list/react-native.js')
    })
    expect(
      resolved('@legendapp/list/react-native', join(components, 'Other.tsx'))
    ).equals(undefined)
  })
})
