import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  chatCoreResolvePlugin,
  resolveChatCore,
  resolveSolver
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
  resolveSolver: (
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

  it('sends the Auto-Scheduler engine to engine.ts, and leaves its twins alone', function () {
    const engine = join(root, 'src', 'common', 'scheduler', 'engine')
    expect(
      resolveSolver(join(root, 'src/common'), './scheduler/engine', root)
    ).equals(`${engine}.ts`)
    for (const twin of ['./engine.web', './engine.native', './nativeEngine'])
      expect(
        resolveSolver(join(root, 'src/common/scheduler'), twin, root)
      ).equals(undefined)
    expect(resolveSolver(join(root, 'src/app'), './engine', root)).equals(
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
    expect(hooks).lengthOf(3)
    const [coreHook, engineHook, addonHook] = hooks
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
    const engine = join(root, 'src', 'common', 'scheduler', 'engine')
    expect(engineHook.filter.test('../common/scheduler/engine')).equals(true)
    expect(engineHook.filter.test('./engine.web')).equals(false)
    expect(
      engineHook.callback({
        path: './scheduler/engine',
        resolveDir: join(root, 'src/common')
      })
    ).deep.equals({ path: `${engine}.ts` })
    expect(
      engineHook.callback({ path: './engine', resolveDir: join(root, 'src') })
    ).equals(undefined)
    expect(addonHook.filter.test('chat_crypto.node')).equals(true)
    expect(addonHook.filter.test('scheduler.node')).equals(true)
    expect(
      addonHook.callback({ path: '/x/chat_crypto.node', resolveDir: root })
    ).deep.equals({ path: '/x/chat_crypto.node', external: true })
    expect(
      addonHook.callback({ path: '/x/scheduler.node', resolveDir: root })
    ).deep.equals({ path: '/x/scheduler.node', external: true })
  })
})
