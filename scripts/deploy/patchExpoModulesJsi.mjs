// ExpoModulesJSI compiles inside its own xcodebuild. That invocation starts
// from a clean environment and passes -quiet, so an archive-level
// SWIFT_ENABLE_EXPLICIT_MODULES setting never reaches it, and a Swift compile
// that exits 0 with no output is reported as `error:` with nothing after it.
// Xcode 27 then fails the archive. This turns explicit modules off in that
// script and drops -quiet so a later failure still prints its reason.

import { readFileSync, writeFileSync } from 'node:fs'

const file =
  process.argv[2] ??
  'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh'
const setting = 'SWIFT_ENABLE_EXPLICIT_MODULES=NO'

const source = readFileSync(file, 'utf8')
if (source.includes(setting)) process.exit(0)

const quiet = /^[ \t]*-quiet \\$/m
const anchor = /^([ \t]*)CLANG_COVERAGE_MAPPING=NO \\$/m
if (!quiet.test(source) || !anchor.test(source)) {
  console.error(
    `${file} is not the ExpoModulesJSI build script this patch expects`
  )
  process.exit(1)
}

const patched = source
  .replace(quiet, '')
  .replace(anchor, `$1CLANG_COVERAGE_MAPPING=NO \\\n$1${setting} \\`)
writeFileSync(file, patched)
