import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, it } from 'mocha'

const script = path.join(__dirname, 'patchExpoModulesJsi.mjs')
const fixture = `
    -quiet \\
    CLANG_ENABLE_CODE_COVERAGE=NO \\
    CLANG_COVERAGE_MAPPING=NO \\
`

describe('patchExpoModulesJsi', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true })
    dirs.length = 0
  })

  function copy(text: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'patch-expo-jsi-'))
    dirs.push(dir)
    const file = path.join(dir, 'build-xcframework.sh')
    writeFileSync(file, text)
    return file
  }

  it('turns explicit modules off and keeps the xcodebuild command intact', () => {
    const file = copy(fixture)
    execFileSync(process.execPath, [script, file])
    const patched = readFileSync(file, 'utf8')
    assert.equal(patched.includes('-quiet'), false)
    assert.match(
      patched,
      /^ {4}CLANG_COVERAGE_MAPPING=NO \\\n {4}SWIFT_ENABLE_EXPLICIT_MODULES=NO \\$/m
    )
    execFileSync(process.execPath, [script, file])
    assert.equal(readFileSync(file, 'utf8'), patched)
  })

  it('refuses a script that is not the ExpoModulesJSI build', () => {
    const file = copy('echo untouched\n')
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, file], {
          encoding: 'utf8',
          stdio: 'pipe'
        }),
      /not the ExpoModulesJSI build script/
    )
  })

  it('patches the installed expo-modules-jsi 58.0.3 script', () => {
    const installed = path.join(
      __dirname,
      '../../node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh'
    )
    const file = copy(readFileSync(installed, 'utf8'))
    execFileSync(process.execPath, [script, file])
    const patched = readFileSync(file, 'utf8')
    assert.equal(patched.includes('-quiet'), false)
    assert.match(
      patched,
      /-configuration "\$CONFIGURATION" \\\n {4}-disableAutomaticPackageResolution \\\n/
    )
    assert.match(
      patched,
      /\n {4}CLANG_COVERAGE_MAPPING=NO \\\n {4}SWIFT_ENABLE_EXPLICIT_MODULES=NO \\\n/
    )
    execFileSync('bash', ['-n', file])
  })
})
