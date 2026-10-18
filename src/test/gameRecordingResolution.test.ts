import { expect } from 'chai'
import { existsSync, realpathSync, statSync } from 'fs'
import { type CustomResolutionContext, resolve } from 'metro-resolver'
import path from 'path'

const root = path.resolve(__dirname, '../..')
const { resolver } = require('../../metro.config')

describe('game hero recording platform resolution', () => {
  for (const platform of ['ios', 'android']) {
    it(`loads the native recording hook on ${platform}`, () => {
      // Resolve the same extensionless import as GameScreen using the real
      // Metro configuration. Explicit .native imports in hook tests miss
      // mismatched extensions that let the browser stub win in app bundles.
      const context: CustomResolutionContext = {
        ...resolver,
        allowHaste: false,
        assetExts: new Set(resolver.assetExts),
        customResolverOptions: {},
        dev: false,
        doesFileExist: existsSync,
        getPackage: () => null,
        getPackageForModule: () => null,
        fileSystemLookup: file => {
          if (!existsSync(file)) return { exists: false }
          return {
            exists: true,
            type: statSync(file).isDirectory() ? 'd' : 'f',
            realPath: realpathSync(file)
          }
        },
        mainFields: resolver.resolverMainFields,
        originModulePath: path.join(root, 'src/app/screens/GameScreen.tsx'),
        preferNativePlatform: true,
        redirectModulePath: file => file,
        resolveAsset: () => null,
        resolveHasteModule: () => null,
        resolveHastePackage: () => null,
        resolveRequest: resolve,
        unstable_logWarning: message => {
          throw new Error(message)
        }
      }

      expect(
        resolver.resolveRequest(context, '../stream/useGameRecording', platform)
      ).deep.equals({
        type: 'sourceFile',
        filePath: path.join(root, 'src/app/stream/useGameRecording.native.tsx')
      })
    })
  }
})
