import { expect } from 'chai'

import { concreteEnv, headerNames, legacyCommand } from './legacyCommand'

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

  it('treats a serving line as setup, leaves a placeholder setup line to the runner, and takes the mocha line as the test', function () {
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
    expect(command.setup.map(step => step.argv[0])).deep.equals(['npm'])
    expect(command.setup[0].background).equals(true)
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

  it('starts the command at node when a placeholder contains a space', function () {
    const source = `
/**
 *   TS_PLAYER_APP=<app origin> \\
 *     node -r sucrase/register scripts/e2e/playerLayouts/capture.ts
 */
`
    const command = legacyCommand(
      source,
      'scripts/e2e/playerLayouts/capture.ts'
    )
    expect(command.blocked).equals(undefined)
    expect(command.argv).deep.equals([
      'node',
      '-r',
      'sucrase/register',
      'scripts/e2e/playerLayouts/capture.ts'
    ])
    expect(command.env.TS_PLAYER_APP).equals('<app origin>')
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

  it('replaces a known value and blocks a placeholder that remains', function () {
    const filled = concreteEnv(
      { MAESTRO_D_BIN: '<maestro-d>', E20_BROWSER: '/usr/bin/chromium' },
      { MAESTRO_D_BIN: '/opt/maestro-d' }
    )
    expect(filled.blocked).equals(undefined)
    expect(filled.env.MAESTRO_D_BIN).equals('/opt/maestro-d')
    const open = concreteEnv({ E20_BROWSER: '<binary>' })
    expect(open.blocked).matches(/E20_BROWSER/)
  })

  it('names the variables a header says are required', function () {
    const source = `// Required: SCORING_DEVICE_UDID, SCORING_ARTIFACT_DIR.
const device = process.env[key]
`
    expect(headerNames(source)).includes('SCORING_DEVICE_UDID')
    expect(headerNames(source)).includes('SCORING_ARTIFACT_DIR')
  })

  it('takes the first command that names the file, without its optional parts', function () {
    const source = `
/**
 *   TS_TOKEN=<session> node scripts/e2e/scoreboardLog/e3.mjs --game <G> \\
 *     [--api http://127.0.0.1:9140/api/v1]
 *
 * Against a seat:
 *   TS_TOKEN=<session> SEAT=1 node scripts/e2e/scoreboardLog/e3.mjs --seat
 */
`
    const command = legacyCommand(
      source,
      'scripts/e2e/scoreboardLog/e3.mjs',
      settings
    )
    expect(command.argv).deep.equals([
      'node',
      'scripts/e2e/scoreboardLog/e3.mjs',
      '--game'
    ])
    expect('SEAT' in command.env).equals(false)
  })

  it('keeps a placeholder with spaces as one token', function () {
    const source = `
// MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \\
//   node scripts/e2e/scoreboardLog/e5.mjs --game <G>
`
    const command = legacyCommand(source, 'scripts/e2e/scoreboardLog/e5.mjs', {
      maestroClientRoot: '/opt/maestro-client'
    })
    expect(command.argv.slice(0, 2)).deep.equals([
      'node',
      'scripts/e2e/scoreboardLog/e5.mjs'
    ])
    expect(command.env.MAESTRO_D_CLIENT_ROOT).equals('/opt/maestro-client')
  })
})
