'use strict'

const { readdirSync } = require('node:fs')

// The React Native twins the app's changed-line gate leaves out. A native twin
// runs on a phone, never under jsdom, except the camera area's: the files
// directly in `src/app/stream` are mounted under jsdom by their suites.
function nativeExcludes(appRoot = 'src/app') {
  const folders = readdirSync(appRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'stream')
    .map(entry => entry.name)
  return [
    `${appRoot}/*.native.tsx`,
    `${appRoot}/stream/*/**/*.native.tsx`,
    ...folders.map(folder => `${appRoot}/${folder}/**/*.native.tsx`)
  ]
}

module.exports = { nativeExcludes }
