import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

const {
  findCargo,
  homePathIn,
  main,
  targetDir
}: {
  findCargo: (env: Record<string, string>) => { error?: string }
  homePathIn: (bytes: Uint8Array, home?: string) => string | undefined
  main: (argv?: string[], env?: Record<string, string>) => number
  targetDir: (env?: Record<string, string>) => string
} = require('../../scripts/chatCryptoBuild.mjs')

/** `scripts/chatCryptoBuild.mjs`: the chat crypto core's two builds. */
describe('the chat crypto build', function () {
  this.timeout(600000)
  const empty = mkdtempSync(join(tmpdir(), 'ts-no-cargo-'))
  let logged: string[] = []
  const realError = console.error
  const realLog = console.log

  before(function () {
    console.error = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }
    console.log = console.error
  })

  after(function () {
    console.error = realError
    console.log = realLog
    rmSync(empty, { recursive: true, force: true })
  })

  it('builds the Node addon and the WASM module', function () {
    logged = []
    expect(main(['node', 'wasm'])).equals(0)
    expect(logged.join('\n')).contains('chat crypto node: ')
    expect(logged.join('\n')).contains('chat crypto wasm: ')
    const module = readFileSync('src/common/chatCrypto/wasm/chat_crypto.wasm')
    expect(homePathIn(module)).equals(undefined)
    expect(module.subarray(0, 4).toString('hex')).equals('0061736d')
  })

  it('refuses without cargo, and says how to get it', function () {
    const env = { PATH: empty, HOME: empty, CARGO_HOME: empty }
    expect(findCargo(env).error).contains('rustup')
    logged = []
    expect(main(['node'], env)).equals(1)
    expect(logged.join('\n')).contains('No cargo')
  })

  it('reads the outputs from CARGO_TARGET_DIR when it is set', function () {
    const crate = join(process.cwd(), 'crates', 'chat-crypto')
    expect(targetDir({})).equals(join(crate, 'target'))
    expect(targetDir({ CARGO_TARGET_DIR: '' })).equals(join(crate, 'target'))
    expect(targetDir({ CARGO_TARGET_DIR: '/var/app/cargo-target' })).equals(
      '/var/app/cargo-target'
    )
    expect(targetDir({ CARGO_TARGET_DIR: 'shared' })).equals(
      join(crate, 'shared')
    )
  })

  it('refuses a target it does not build', function () {
    logged = []
    expect(main(['ios'])).equals(2)
    expect(logged.join('\n')).contains('usage')
  })

  it('finds any home-directory path in a module', function () {
    const bytes = (text: string): Buffer => Buffer.from(`\u0000${text}\u0000`)
    expect(homePathIn(bytes('/Users/dev/x'), '/nowhere')).equals('/Users/')
    expect(homePathIn(bytes('/home/dev/x'), '/nowhere')).equals('/home/')
    expect(homePathIn(bytes('/root/.cargo'), '/nowhere')).equals('/root/')
    expect(homePathIn(bytes('/opt/me/x'), '/opt/me')).equals('/opt/me')
    expect(homePathIn(bytes('chat-crypto/src/abi.rs'), '/opt/me')).equals(
      undefined
    )
    expect(homePathIn(bytes('anything'), '')).equals(undefined)
  })
})
