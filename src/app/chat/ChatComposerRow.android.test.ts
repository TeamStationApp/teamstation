import assert from 'node:assert/strict'
import Module from 'node:module'

describe('Android chat composer keyboard host', () => {
  it('requests the native view that intercepts hardware keys before the keyboard', () => {
    const rn = require.resolve('react-native')
    const component = require.resolve('./ChatComposerRow.android')
    const savedRuntime = require.cache[rn]
    const savedComponent = require.cache[component]
    const row = {}
    const runtime = new Module(rn)
    runtime.exports = {
      requireNativeComponent(name: string) {
        assert.equal(name, 'TSChatComposerKeys')
        return row
      }
    }
    try {
      require.cache[rn] = runtime
      Reflect.deleteProperty(require.cache, component)
      const loaded = require(component) as { ChatComposerRow: unknown }
      assert.equal(loaded.ChatComposerRow, row)
    } finally {
      if (savedRuntime == null) Reflect.deleteProperty(require.cache, rn)
      else require.cache[rn] = savedRuntime
      if (savedComponent == null)
        Reflect.deleteProperty(require.cache, component)
      else require.cache[component] = savedComponent
    }
  })
})
