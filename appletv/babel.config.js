const { bundleBuildInfo } = require('../scripts/build-info.cjs')
process.env.TS_BUILD_INFO = bundleBuildInfo()

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      require.resolve('babel-plugin-transform-inline-environment-variables'),
      { include: ['TS_BUILD_INFO'] }
    ]
  ]
}
