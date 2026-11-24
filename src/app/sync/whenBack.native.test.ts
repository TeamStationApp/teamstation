import { Script } from 'node:vm'

import { expect } from 'chai'
import { buildSync } from 'esbuild'
import { describe, it } from 'mocha'

// Bundled with native resolution, just as Metro does: the phone's network
// and app-state watches, with the libraries they use replaced.
const bundle = buildSync({
  entryPoints: ['src/app/sync/whenBack.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  resolveExtensions: ['.native.ts', '.ts', '.js', '.json'],
  external: ['react-native', '@react-native-community/netinfo']
}).outputFiles[0].text

interface NetState {
  isConnected: boolean
  isInternetReachable: boolean | null
}

/** The phone: its network, which answers a new listener at once, and its app state. */
function phone(start: NetState): {
  whenBack: (again: () => void) => () => void
  network: (state: NetState) => void
  front: (state: string) => void
  listeners: () => number
} {
  let current = start
  const nets = new Set<(state: NetState) => void>()
  const apps = new Set<(state: string) => void>()
  const modules: Record<string, unknown> = {
    '@react-native-community/netinfo': {
      // As the library does: the state it has, to a listener as it is added.
      addEventListener: (listener: (state: NetState) => void) => {
        nets.add(listener)
        listener(current)
        return () => {
          nets.delete(listener)
        }
      }
    },
    'react-native': {
      AppState: {
        currentState: 'active',
        addEventListener: (
          _type: string,
          listener: (state: string) => void
        ) => {
          apps.add(listener)
          return {
            remove: () => {
              apps.delete(listener)
            }
          }
        }
      }
    }
  }
  const module: { exports: { whenBack?: (again: () => void) => () => void } } =
    { exports: {} }
  new Script(
    `(function(require,module,exports){${bundle}\n})`
  ).runInThisContext()(
    (name: string) => {
      if (!(name in modules))
        throw new Error(`Unexpected native dependency: ${name}`)
      return modules[name]
    },
    module,
    module.exports
  )
  return {
    whenBack: module.exports.whenBack!,
    network: state => {
      current = state
      for (const listener of [...nets]) listener(state)
    },
    front: state => {
      for (const listener of [...apps]) listener(state)
    },
    listeners: () => nets.size + apps.size
  }
}

const UP: NetState = { isConnected: true, isInternetReachable: true }
const DOWN: NetState = { isConnected: false, isInternetReachable: false }

describe('waiting for the phone’s network or the app to come back', () => {
  it('runs nothing for a network that is already up, and once when it comes back', () => {
    const device = phone(UP)
    let runs = 0
    device.whenBack(() => {
      runs++
    })
    expect(runs, 'the state the watch began in').equals(0)
    device.network(UP)
    expect(runs).equals(0)
    device.network(DOWN)
    device.network(UP)
    device.network(DOWN)
    device.network(UP)
    expect(runs).equals(1)
    expect(device.listeners(), 'nothing left listening').equals(0)
  })

  it('runs once when a network that was down comes up', () => {
    const device = phone(DOWN)
    let runs = 0
    device.whenBack(() => {
      runs++
    })
    expect(runs).equals(0)
    device.network({ isConnected: true, isInternetReachable: null })
    expect(runs).equals(1)
    expect(device.listeners()).equals(0)
  })

  it('runs once when the app comes to the front, and nothing once stopped', () => {
    const device = phone(UP)
    let runs = 0
    device.whenBack(() => {
      runs++
    })
    device.front('background')
    device.front('active')
    device.front('active')
    expect(runs).equals(1)
    const stop = device.whenBack(() => {
      runs++
    })
    stop()
    device.front('background')
    device.front('active')
    expect(runs).equals(1)
    expect(device.listeners()).equals(0)
  })
})
