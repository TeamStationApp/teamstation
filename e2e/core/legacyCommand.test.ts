import { expect } from 'chai'

import { legacyCommand } from './legacyCommand'

const settings = {
  maestroClientRoot: '/opt/maestro-client',
  maestroBin: '/opt/maestro-d'
}

describe('legacyCommand', function () {
  it('reads a continued header and rewrites the daemon', function () {
    const source = `
/**
 *   E20_BROWSER=<binary> MAESTRO_D=<daemon> \\
 *   MAESTRO_D_CLIENT_ROOT=<package> \\
 *     npx mocha -r sucrase/register --extension ts --timeout 1800000 \\
 *     src/app/player/liveOutage.e2e.ts
 */
`
    const command = legacyCommand(
      source,
      'src/app/player/liveOutage.e2e.ts',
      settings
    )
    expect(command.blocked).equals(undefined)
    expect(command.argv[0]).equals('npx')
    expect(command.argv.at(-1)).equals('src/app/player/liveOutage.e2e.ts')
    expect(command.env.MAESTRO_D).equals('e2eSuite')
    expect(command.env.MAESTRO_D_CLIENT_ROOT).equals('/opt/maestro-client')
    expect(command.env.E20_BROWSER).equals('<binary>')
  })

  it('treats a serving line as setup and the mocha line as the test', function () {
    const source = `
/**
 *   scripts/chat-e2e-reset.sh <artifacts>
 *   npm start
 *   TS_CHAT_ARTIFACTS=<artifacts> \\
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \\
 *     --timeout 180000 src/app/chat/chat.e2e.ts
 */
`
    const command = legacyCommand(source, 'src/app/chat/chat.e2e.ts', settings)
    expect(command.setup.map(step => step.argv[0])).deep.equals([
      'scripts/chat-e2e-reset.sh',
      'npm'
    ])
    expect(command.setup[0].background).equals(false)
    expect(command.setup[1].background).equals(true)
    expect(command.argv[0]).equals('node_modules/.bin/mocha')
    expect(command.env.MAESTRO_D).equals('e2eSuite')
  })

  it('falls back to mocha when the header names no command', function () {
    const source = `
import { describe, it } from 'mocha'
describe('account', function () {})
`
    const command = legacyCommand(source, 'src/app/accountSettings.e2e.ts')
    expect(command.argv.slice(0, 2)).deep.equals(['npx', 'mocha'])
    expect(command.argv.at(-1)).equals('src/app/accountSettings.e2e.ts')
    expect(command.env.MAESTRO_D).equals('e2eSuite')
  })

  it('falls back to node for a main script and an mjs', function () {
    const ts = legacyCommand(
      'async function main(): Promise<void> {}\nvoid main()',
      'src/app/uiTweaks.e2e.ts'
    )
    expect(ts.argv).deep.equals([
      'node',
      '-r',
      'sucrase/register',
      'src/app/uiTweaks.e2e.ts'
    ])
    const mjs = legacyCommand(
      'const value = await Promise.resolve(1)\n',
      'scripts/scoring-safari.mjs'
    )
    expect(mjs.argv).deep.equals(['node', 'scripts/scoring-safari.mjs'])
  })

  it('reads a leading line comment and ignores later comments', function () {
    const source = `// Run it:
//   MAESTRO_D=<daemon> \\
//     node -r sucrase/register src/app/stream/streamManagement.e2e.ts
const note = 1
// node somewhere/else.ts
`
    const command = legacyCommand(
      source,
      'src/app/stream/streamManagement.e2e.ts',
      settings
    )
    expect(command.blocked).equals(undefined)
    expect(command.argv.slice(0, 3)).deep.equals([
      'node',
      '-r',
      'sucrase/register'
    ])
    expect(command.env.MAESTRO_D).equals('e2eSuite')
  })

  it('records the native settings flow as blocked', function () {
    const command = legacyCommand(
      'async function main() {}',
      'src/app/settingsCleanup3Native.e2e.ts'
    )
    expect(command.blocked).includes('TS_SETTINGS3_NATIVE_FLOW')
  })
})
