import assert from 'node:assert/strict'
import Module from 'node:module'

describe('chat message links on native', () => {
  it('uses the Safari module on iOS and the chat-specific browser intent on Android', async () => {
    const rn = require.resolve('react-native')
    const paths = [
      rn,
      require.resolve('./NativeChatBrowser'),
      require.resolve('./chatBrowser.native')
    ]
    const original = paths.map(path => require.cache[path])
    const calls: string[] = []
    const platform = { OS: 'ios' }
    const modules = {
      TSExternalBrowser: {
        openChatLink: async (url: string) => {
          calls.push('Android ' + url)
        }
      }
    }
    const reactNative = new Module(rn)
    reactNative.exports = {
      NativeModules: modules,
      Platform: platform,
      TurboModuleRegistry: {
        get: (name: string) => {
          assert.equal(name, 'TSChatBrowser')
          return {
            open: async (url: string) => {
              calls.push('Safari ' + url)
            }
          }
        }
      }
    }
    try {
      for (const path of paths) Reflect.deleteProperty(require.cache, path)
      require.cache[rn] = reactNative
      const { openChatBrowser, chatAppOrigin } =
        await import('./chatBrowser.native')
      assert.ok(chatAppOrigin().startsWith('https://'))
      const url = 'http://example.com/game?x=1#t'
      await openChatBrowser(url)
      platform.OS = 'android'
      await openChatBrowser(url)
      platform.OS = 'macos'
      await assert.rejects(openChatBrowser(url), /unavailable/)
      assert.deepEqual(calls, ['Safari ' + url, 'Android ' + url])
    } finally {
      paths.forEach((path, index) => {
        if (original[index] != null) require.cache[path] = original[index]
        else Reflect.deleteProperty(require.cache, path)
      })
    }
  })
})
