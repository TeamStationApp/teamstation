// An esbuild plugin for bundles that run in Node (the bundled app tests):
// the chat crypto core resolves to its Node twin, `core.ts`, which loads the
// Node-API addon, instead of the browser's `core.web.ts` the web settings'
// `.web.ts` first rule would pick. The addon itself stays outside the bundle.
import { resolve } from 'node:path'

/** `core.ts` for an import of the chat crypto core, undefined for anything else. */
export function resolveChatCore(resolveDir, importPath, root = process.cwd()) {
  const core = resolve(root, 'src', 'common', 'chatCrypto', 'core')
  return resolve(resolveDir, importPath) === core ? `${core}.ts` : undefined
}

export function chatCoreResolvePlugin(root = process.cwd()) {
  return {
    name: 'chat-core-node',
    setup(build) {
      build.onResolve({ filter: /(^|\/)core$/ }, args => {
        const path = resolveChatCore(args.resolveDir, args.path, root)
        return path == null ? undefined : { path }
      })
      build.onResolve({ filter: /\.node$/ }, args => ({
        path: args.path,
        external: true
      }))
    }
  }
}
