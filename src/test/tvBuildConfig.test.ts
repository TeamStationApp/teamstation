import { createRequire } from 'node:module'
import path from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
const requireConfig = createRequire(path.resolve('appletv/package.json'))
describe('TV build configuration', () => {
  it('isolates the native runtime while preserving nested dependencies', () => {
    const config = requireConfig('./metro.config.js')
    const origin = path.resolve('src/app/tv/TvApp.tsx')
    const calls: Array<{ origin: string; name: string; platform: string }> = []
    const context = {
      originModulePath: origin,
      resolveRequest: (context: any, name: string, platform: string) => {
        calls.push({ origin: context.originModulePath, name, platform })
        return { filePath: name }
      }
    }
    for (const name of [
      'react',
      'react-native',
      'react-native/feature',
      'react-native-video',
      'react-native-svg',
      'react-native-safe-area-context',
      'react-native-patina'
    ]) {
      expect(config.resolver.resolveRequest(context, name, 'ios')).deep.equals({
        filePath: name
      })
      expect(calls.at(-1)!.origin).equals(path.resolve('appletv/index.js'))
    }
    config.resolver.resolveRequest(context, 'cleaners', 'ios')
    expect(calls.at(-1)!.origin).equals(origin)
    expect(config.watchFolders).contains(path.resolve('src'))
    expect(
      config.resolver.blockList.some((r: RegExp) =>
        r.test('/app/appletv/DerivedData/file')
      )
    ).equals(true)
    expect(requireConfig('./babel.config.js').presets).deep.equals([
      'module:@react-native/babel-preset'
    ])
    expect(
      requireConfig('./react-native.config.js').project.ios.sourceDir
    ).equals('./ios')
  })
})
