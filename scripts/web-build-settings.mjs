import babel from '@babel/core'
import { readFile } from 'fs/promises'

export const worklets = {
  name: 'reanimated-worklets',
  setup(pluginBuild) {
    // `.tsx?`, not `.tsx`: a hook file is plain TypeScript and is exactly where
    // a shared worklet ends up, so a filter that missed it left
    // `useAnimatedStyle` uncompiled and every screen using it blank.
    pluginBuild.onLoad({ filter: /app\/.*\.tsx?$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      // Only files that mention Reanimated can contain a worklet, and the check
      // costs nothing next to parsing a file that cannot.
      if (!/react-native-reanimated|['"]worklet['"]/.test(source)) return null
      const result = await babel.transformAsync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: 'inline',
        plugins: [
          ['@babel/plugin-syntax-typescript', { isTSX: true }],
          '@babel/plugin-syntax-jsx',
          'react-native-worklets/plugin'
        ]
      })
      return { contents: result.code, loader: 'tsx' }
    })
  }
}

export const webSettings = {
  plugins: [worklets],
  alias: { 'react-native': 'react-native-web' },
  resolveExtensions: [
    '.web.tsx',
    '.web.ts',
    '.web.jsx',
    '.web.js',
    '.tsx',
    '.ts',
    '.jsx',
    '.js',
    '.json'
  ]
}
