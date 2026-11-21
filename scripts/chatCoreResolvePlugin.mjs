// An esbuild plugin for bundles that run in Node (the bundled app tests):
// the chat crypto core resolves to its Node twin, `core.ts`, which loads the
// Node-API addon, instead of the browser's `core.web.ts` the web settings'
// `.web.ts` first rule would pick. The addon itself stays outside the bundle.
// The Auto-Scheduler's engine resolves the same way, to `engine.ts`, which
// loads the engine's addon, `scheduler.node`, also left outside.
import { resolve } from 'node:path'

/** `core.ts` for an import of the chat crypto core, undefined for anything else. */
export function resolveChatCore(resolveDir, importPath, root = process.cwd()) {
  const core = resolve(root, 'src', 'common', 'chatCrypto', 'core')
  return resolve(resolveDir, importPath) === core ? `${core}.ts` : undefined
}

/** `engine.ts` for an import of the Auto-Scheduler's engine, undefined otherwise. */
export function resolveSolver(resolveDir, importPath, root = process.cwd()) {
  const engine = resolve(root, 'src', 'common', 'scheduler', 'engine')
  return resolve(resolveDir, importPath) === engine ? `${engine}.ts` : undefined
}

export function chatCoreResolvePlugin(root = process.cwd()) {
  return {
    name: 'chat-core-node',
    setup(build) {
      build.onResolve({ filter: /(^|\/)core$/ }, args => {
        const path = resolveChatCore(args.resolveDir, args.path, root)
        return path == null ? undefined : { path }
      })
      build.onResolve({ filter: /(^|\/)engine$/ }, args => {
        const path = resolveSolver(args.resolveDir, args.path, root)
        return path == null ? undefined : { path }
      })
      build.onResolve({ filter: /\.node$/ }, args => ({
        path: args.path,
        external: true
      }))
    }
  }
}
