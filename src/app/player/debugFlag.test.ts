import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playerDebug, rememberDebug, tabStore } from './debugFlag'

/** A tab's storage, in memory. */
function memory(): Storage {
  const values = new Map<string, string>()
  return {
    length: 0,
    clear: () => {
      values.clear()
    },
    key: () => null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: key => {
      values.delete(key)
    }
  }
}

describe('player debug flag', function () {
  it('remembers ?debug=1 for the tab after the address loses it, until ?debug=0', function () {
    const store = memory()
    expect(rememberDebug('', store)).equals(false)
    expect(rememberDebug('?video=vid_a&debug=1', store)).equals(true)
    // The app rewrote the address to a game route without the flag.
    expect(rememberDebug('?video=vid_a&t=32', store)).equals(true)
    expect(rememberDebug('?debug=0', store)).equals(false)
    expect(rememberDebug('?tab=watch', store)).equals(false)
  })

  it('still honours the address when storage is missing or refuses', function () {
    expect(rememberDebug('?debug=1', null)).equals(true)
    expect(rememberDebug('', null)).equals(false)
    const refusing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }
    expect(rememberDebug('?debug=1', refusing)).equals(true)
    expect(rememberDebug('', refusing)).equals(false)
  })

  it('reads the page it runs in, through the tab’s own storage', function () {
    const globals = globalThis as {
      location?: { search: string }
      sessionStorage?: Storage
    }
    const saved = {
      location: globals.location,
      sessionStorage: globals.sessionStorage
    }
    globals.sessionStorage = memory()
    try {
      globals.location = { search: '?debug=1' }
      expect(tabStore()).equals(globals.sessionStorage)
      expect(playerDebug()).equals(true)
      globals.location = { search: '?video=vid_a' }
      expect(playerDebug()).equals(true)
      globals.location = { search: '?debug=0' }
      expect(playerDebug()).equals(false)
      delete globals.location
      expect(playerDebug()).equals(false)
    } finally {
      globals.location = saved.location
      globals.sessionStorage = saved.sessionStorage
    }
  })

  it('has no tab store where there is none, or where reading it throws', function () {
    const globals = globalThis as { sessionStorage?: Storage }
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    try {
      delete globals.sessionStorage
      expect(tabStore()).equals(null)
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        get: () => {
          throw new Error('blocked')
        }
      })
      expect(tabStore()).equals(null)
    } finally {
      if (saved == null) delete globals.sessionStorage
      else Object.defineProperty(globalThis, 'sessionStorage', saved)
    }
  })
})
