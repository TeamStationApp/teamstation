import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  chatCoreResolvePlugin,
  resolveChatCore
}: {
  chatCoreResolvePlugin: (root?: string) => {
    name: string
    setup: (build: {
      onResolve: (
        options: { filter: RegExp },
        callback: (args: { path: string; resolveDir: string }) => unknown
      ) => void
    }) => void
  }
  resolveChatCore: (
    resolveDir: string,
    importPath: string,
    root?: string
  ) => string | undefined
} = require('../../scripts/chatCoreResolvePlugin.mjs')

/**
 * `scripts/chatCoreResolvePlugin.mjs`: the bundled app tests run in Node, so
 * the chat crypto core resolves to `core.ts` (the Node addon's), and the
 * addon stays outside the bundle.
 */
describe('the chat core resolver for bundles that run in Node', function () {
  const root = '/repo'
  const core = join(root, 'src', 'common', 'chatCrypto', 'core')

  it('sends every import of the core to core.ts, from anywhere', function () {
    for (const [dir, path] of [
      ['src/common/chatCrypto', './core'],
      ['src/app/chat', '../../common/chatCrypto/core'],
      ['src/app/chat/engine', '../../../common/chatCrypto/core']
    ]) {
      expect(resolveChatCore(join(root, dir), path, root), path).equals(
        `${core}.ts`
      )
    }
  })

  it('leaves the platform twins and every other core alone', function () {
    const dir = join(root, 'src/common/chatCrypto')
    expect(resolveChatCore(dir, './core.web', root)).equals(undefined)
    expect(resolveChatCore(dir, './core.native', root)).equals(undefined)
    expect(resolveChatCore(join(root, 'src/app'), './core', root)).equals(
      undefined
    )
  })

  it('as a plugin: resolves the core, and keeps .node files external', function () {
    const hooks: Array<{
      filter: RegExp
      callback: (args: { path: string; resolveDir: string }) => unknown
    }> = []
    const plugin = chatCoreResolvePlugin(root)
    expect(plugin.name).equals('chat-core-node')
    plugin.setup({
      onResolve: (options, callback) => {
        hooks.push({ filter: options.filter, callback })
      }
    })
    const [coreHook, addonHook] = hooks
    expect(coreHook.filter.test('../chatCrypto/core')).equals(true)
    expect(coreHook.filter.test('./score')).equals(false)
    expect(
      coreHook.callback({
        path: './core',
        resolveDir: join(root, 'src/common/chatCrypto')
      })
    ).deep.equals({ path: `${core}.ts` })
    expect(
      coreHook.callback({ path: './core', resolveDir: join(root, 'src/app') })
    ).equals(undefined)
    expect(addonHook.filter.test('chat_crypto.node')).equals(true)
    expect(
      addonHook.callback({ path: '/x/chat_crypto.node', resolveDir: root })
    ).deep.equals({ path: '/x/chat_crypto.node', external: true })
  })
})
