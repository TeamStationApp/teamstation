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
      extensions: ['.tsx', '.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.client.json'
            }
          },
          exclude: /node_modules/
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
