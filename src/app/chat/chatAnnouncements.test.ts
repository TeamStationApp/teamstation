import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { announceChatArrival as announceWeb } from './chatAnnouncements'

describe('chat accessibility announcement platform dispatch', function () {
  it('queues low-priority iOS announcements while leaving Android and web to live regions', async function () {
    const path = require.resolve('react-native')
    const nativePath = require.resolve('./chatAnnouncements.native')
    const previous = require.cache[path]
    const previousNative = require.cache[nativePath]
    const calls: unknown[] = []
    const platform = { OS: 'ios' }
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    stand.exports = {
      Platform: platform,
      AccessibilityInfo: {
        announceForAccessibilityWithOptions: (text: string, options: object) =>
          calls.push([text, options])
      }
    }
    require.cache[path] = stand
    Reflect.deleteProperty(require.cache, nativePath)
    try {
      const native = await import('./chatAnnouncements.native')
      for (let repeat = 0; repeat < 2; repeat++)
        native.announceChatArrival('New message in Aurora')
      expect(calls).deep.equals([
        ['New message in Aurora', { queue: true, priority: 'low' }],
        ['New message in Aurora', { queue: true, priority: 'low' }]
      ])
      platform.OS = 'android'
      native.announceChatArrival('Android live region')
      announceWeb('Browser live region')
      expect(calls).length(2)
    } finally {
      if (previous != null) require.cache[path] = previous
      else Reflect.deleteProperty(require.cache, path)
      if (previousNative != null) require.cache[nativePath] = previousNative
      else Reflect.deleteProperty(require.cache, nativePath)
    }
  })
})
