import Module from 'node:module'

/**
 * Puts `standIns` where Node would load each named package from, so a
 * phone-only file can be imported in a unit test; answers a function that
 * puts the real ones back.
 */
export function installStandIns(standIns: Record<string, unknown>): () => void {
  const held = new Map<string, NodeJS.Module | undefined>()
  for (const [name, exports] of Object.entries(standIns)) {
    const path = require.resolve(name)
    held.set(path, require.cache[path])
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    stand.exports = exports
    require.cache[path] = stand
  }
  return () => {
    for (const [path, module] of held) {
      if (module == null) Reflect.deleteProperty(require.cache, path)
      else require.cache[path] = module
    }
  }
}
