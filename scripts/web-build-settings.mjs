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

// Only explicitly identified development deployments include the module.
// Archive provenance is supplied by the deployer, independently of Git.
export const developmentPasswordLinks = {
  name: 'development-password-links',
  setup({ initialOptions }) {
    const define = (initialOptions.define ??= {})
    const info = process.env.TS_BUILD_INFO
    const branch = info && JSON.parse(info).branch
    const seat = process.env.TS_SEAT_BRANCH
    const enabled =
      define.TS_API_BASE_URL === JSON.stringify('/api/v1') &&
      ((branch === 'develop' && (seat == null || seat === branch)) ||
        (typeof branch === 'string' &&
          branch.startsWith('paul/') &&
          seat === branch))
    define.TS_PASSWORD_LINK_BUILD = JSON.stringify(Boolean(enabled))
  }
}

export const webSettings = {
  plugins: [worklets, developmentPasswordLinks],
  // 1.0's gradient alias, which came with 1.0's scoreboard: the board keeps
  // 1.0's `react-native-linear-gradient` import, and on the web that is the
  // package that draws it.
  //
  // react-native-svg draws Tess's hold-to-confirm outline on the web too. Its
  // image support asks React Native's asset registry, which on the web is
  // react-native-web's.
  alias: {
    'react-native': 'react-native-web',
    'react-native-linear-gradient': 'react-native-web-linear-gradient',
    '@react-native/assets-registry/registry':
      'react-native-web/dist/modules/AssetRegistry'
  },
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
