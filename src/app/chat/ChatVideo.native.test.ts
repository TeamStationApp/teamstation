import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import type React from 'react'

import type { ChatVideoProps } from './chatVideoProps'

/**
 * The phone's video twin, as a phone loads it: `react-native-video` and the
 * theme are replaced in the module cache, so what it asks the player for is
 * read straight off the element it makes.
 */
const video = require.resolve('react-native-video')
const themeModule = require.resolve('../theme/ThemeContext')
const twin = require.resolve('./ChatVideo.native')

function Video(): null {
  return null
}

const theme = {
  rem: (size: number) => size * 16,
  radiusRem: 0.75,
  videoBackgroundColor: '#000000'
}

function cached(path: string, exports: unknown): void {
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports
  } as unknown as NodeJS.Module
}

describe('an opened chat video on a phone', function () {
  afterEach(function () {
    for (const path of [twin, video, themeModule])
      Reflect.deleteProperty(require.cache, path)
  })

  it('plays the decrypted cache file in the platform player, contained in its rounded box', function () {
    cached(video, { __esModule: true, default: Video })
    cached(themeModule, { useTheme: () => theme })
    const { ChatVideo } = require('./ChatVideo.native') as {
      ChatVideo: (props: ChatVideoProps) => React.ReactElement<{
        accessibilityLabel: string
        source: { uri: string }
        controls: boolean
        paused: boolean
        resizeMode: string
        style: Record<string, unknown>
      }>
    }
    const element = ChatVideo({
      uri: 'file:///cache/chat/att_1.mp4',
      width: 320,
      height: 180,
      label: 'Video from Blair B'
    })
    expect(element.type).equals(Video)
    expect(element.props).deep.equals({
      accessibilityLabel: 'Video from Blair B',
      source: { uri: 'file:///cache/chat/att_1.mp4' },
      controls: true,
      paused: false,
      resizeMode: 'contain',
      style: {
        width: 320,
        height: 180,
        borderRadius: 12,
        backgroundColor: '#000000'
      }
    })
  })
})
