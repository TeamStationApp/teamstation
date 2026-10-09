import Module from 'node:module'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

describe('chat decrypted text clipboard on native', function () {
  let copy: (text: string) => Promise<void>
  let previous: NodeJS.Module | undefined
  const path = require.resolve('@react-native-clipboard/clipboard')
  const copies: string[] = []
  let refused = false

  before(async function () {
    previous = require.cache[path]
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    stand.exports = {
      setString: (text: string) => {
        if (refused) throw new Error('Denied')
        copies.push(text)
      }
    }
    require.cache[path] = stand
    copy = (await import('./chatClipboard.native')).copyChatText
  })

  after(function () {
    if (previous != null) require.cache[path] = previous
    else Reflect.deleteProperty(require.cache, path)
  })

  it('passes the exact decrypted body or caption to the native clipboard', async function () {
    await copy('  Bring water\nCaption ❤️  ')
    expect(copies).deep.equals(['  Bring water\nCaption ❤️  '])
  })

  it('rejects a native clipboard failure so the menu can show feedback', async function () {
    refused = true
    let failed: unknown
    await copy('Opened body').catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('Denied')
    expect(copies).length(1)
    refused = false
  })

  it('uses the clipboard package default export when the native package is an ES module', async function () {
    const nativePath = require.resolve('./chatClipboard.native')
    const previousNative = require.cache[nativePath]
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    const exact: string[] = []
    stand.exports = {
      __esModule: true,
      default: { setString: (text: string) => exact.push(text) }
    }
    require.cache[path] = stand
    Reflect.deleteProperty(require.cache, nativePath)
    try {
      const native = await import('./chatClipboard.native')
      await native.copyChatText('Opened caption')
      expect(exact).deep.equals(['Opened caption'])
    } finally {
      if (previousNative != null) require.cache[nativePath] = previousNative
    }
  })
})
