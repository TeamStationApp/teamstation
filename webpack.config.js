const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const webpack = require('webpack')

module.exports = (env, argv) => {
  const isDevelopment = argv.mode === 'development'

  return {
    entry: './src/client/index.tsx',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.js',
      clean: true,
      publicPath: '/'
    },
    resolve: {
      extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.js', '.js'],
      alias: {
        '@common': path.resolve(__dirname, 'src/common'),
        'react-native$': 'react-native-web',
        'react-native-linear-gradient': 'react-native-web-linear-gradient'
      }
    },
    module: {
      rules: [
        {
          test: /\.(tsx?|jsx?)$/,
          exclude:
            /node_modules\/(?!(react-native|@react-native|react-native-web|react-router-native)\/).*/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-react',
                [
                  '@babel/preset-typescript',
                  {
                    isTSX: true,
                    allExtensions: true
                  }
                ]
              ],
              plugins: ['react-native-web']
            }
          }
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader']
        },
        {
          test: /\.(png|jpe?g|gif|svg)$/i,
          type: 'asset/resource'
        }
      ]
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/client/index.html'
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: 'src/client/assets',
            to: 'assets'
          }
        ]
      }),
      // Only inject WEBPACK_DEV variable in development mode
      ...(isDevelopment
        ? [
            new webpack.DefinePlugin({
              'window.__WEBPACK_DEV__': JSON.stringify(true)
            })
          ]
        : [])
    ],
    devServer: {
      compress: true,
      port: 8080,
      hot: true,
      historyApiFallback: {
        index: '/'
      },
      devMiddleware: {
        publicPath: '/'
      },
      proxy: {
        '/api': {
          target: 'http://localhost:8008',
          changeOrigin: true
        }
      }
    }
  }
}
