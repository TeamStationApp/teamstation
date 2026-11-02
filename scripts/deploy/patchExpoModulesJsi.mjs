// ExpoModulesJSI compiles inside its own xcodebuild, which passes -quiet.
// Xcode 27 reports a Swift compile that exits 0 with no output as an error,
// and the quiet flag is what leaves the warning unprinted, so the archive
// fails. This turns explicit modules off on that invocation and drops -quiet,
// keeping the command's line continuations.

import { readFileSync, writeFileSync } from 'node:fs'

const file =
  process.argv[2] ??
  'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh'
const setting = 'SWIFT_ENABLE_EXPLICIT_MODULES=NO'

const source = readFileSync(file, 'utf8')
if (source.includes(setting)) process.exit(0)

const quiet = /^[ \t]*-quiet \\\n/m
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
