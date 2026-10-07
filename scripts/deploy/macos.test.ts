import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import type { Signing } from './apple'
import { resolveSettings } from './config'
import { app, fixtureSettings, testRoot } from './config.test'
import { macos, notarize, packageMac, signingOrder } from './macos'
import { type Command, Processes } from './process'
import type { BuildContext } from './runner'
import { target } from './targets'
const id = 'app.teamstation.distributor'
let root: string,
  context: BuildContext,
  original: Processes['run'],
  calls: Command[],
  response: string,
  details: string,
  certificate: Buffer,
  keychains: string[],
  rejectTool: string | undefined
function file(name: string, data: string | Buffer = 'fixture'): void {
  mkdirSync(path.dirname(name), { recursive: true })
  writeFileSync(name, data)
}
async function fake(command: Command): Promise<string> {
  calls.push(command)
  if (command.file === rejectTool) throw new Error('Tool failed')
  if (command.file === 'security') {
    if (command.args[0] === 'list-keychains') {
      if (command.args.includes('-s')) keychains = command.args.slice(4)
      return keychains.map(p => JSON.stringify(p)).join('\n')
    }
    if (command.args[0] === 'default-keychain')
      return JSON.stringify(path.join(root, 'login.keychain'))
  }
  if (command.file === 'xcodebuild') {
    const destination = command.args[command.args.indexOf('-archivePath') + 1]
    file(
      path.join(
        destination,
        'Products/Applications/Example.app/Contents/MacOS/Example'
      ),
      Buffer.from('cffaedfe01020304', 'hex')
    )
    file(
      path.join(
        destination,
        'Products/Applications/Example.app/Contents/Info.plist'
      )
    )
  }
  if (command.file === 'ditto' && command.args[0] !== '-c')
    cpSync(command.args[0], command.args[1], { recursive: true })
  if (command.file === 'codesign') {
    if (command.args.includes('--extract-certificates'))
      file(command.args[2] + '0', certificate)
    if (command.args.includes('--verbose=4')) return details
  }
  if (command.file === 'plutil')
    return JSON.stringify({
      CFBundleIdentifier: id,
      CFBundleVersion: '1.0.42',
      CFBundleShortVersionString: '1.2.3',
      CFBundleExecutable: 'Example'
    })
  if (command.file === 'xcrun') {
    if (command.args[0] === 'lipo') return 'x86_64 arm64'
    if (command.args[0] === 'notarytool') return response
  }
  if (command.file === 'hdiutil') file(command.args.at(-1)!)
  return ''
}
describe('Notarized macOS packaging', () => {
  beforeEach(() => {
    root = testRoot('macos-')
    const settings = resolveSettings(
      {
        schemaVersion: 1,
        branches: { master: { settings: fixtureSettings(root) } }
      },
      'master'
    )
    settings.apps[id] = {
      ...settings.apps[app],
      macos: {
        ...settings.apps[app].ios!,
        apple: {
          ...settings.apps[app].ios!.apple!,
          profileNames: {},
          architectures: ['arm64', 'x86_64'],
          identity: 'Developer ID Application: Fixture',
          notarizationProfile: 'fixture',
          notarizationKeychain: path.join(root, 'login.keychain')
        }
      }
    }
    context = {
      source: path.join(root, 'source'),
      output: path.join(root, 'output'),
      settings,
      target: target(id, 'macos'),
      branch: 'master',
      commit: 'a'.repeat(40),
      version: '1.2.3',
      buildNumber: 42,
      buildTime: '2026-01-01T00:00:00Z',
      processes: new Processes(new AbortController().signal)
    }
    mkdirSync(path.join(context.source, context.target.path), {
      recursive: true
    })
    mkdirSync(context.output)
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=Developer ID Application: Fixture/OU=EXAMPLETEAM',
        '-keyout',
        path.join(root, 'certificate.key'),
        '-out',
        path.join(root, 'certificate.pem')
      ],
      { stdio: 'ignore' }
    )
    certificate = new X509Certificate(
      readFileSync(path.join(root, 'certificate.pem'))
    ).raw
    calls = []
    keychains = [path.join(root, 'login.keychain')]
    response = JSON.stringify({ id: 'fixture-submission', status: 'Accepted' })
    details = 'TeamIdentifier=EXAMPLETEAM\nCodeDirectory flags=0x10000(runtime)'
    rejectTool = undefined
    // eslint-disable-next-line @typescript-eslint/unbound-method
    original = Processes.prototype.run
    Processes.prototype.run = fake
  })
  afterEach(() => {
    Processes.prototype.run = original
    rmSync(root, { recursive: true, force: true })
  })
  it('archives universal code, signs from the inside out, notarizes and staples app and disk image', async () => {
    const out = await macos(context)
    assert(existsSync(out.file))
    assert.equal(out.buildNumber, '1.0.42')
    assert(calls.some(c => c.args.includes('ARCHS=arm64 x86_64')))
    assert.equal(calls.filter(c => c.args[0] === 'notarytool').length, 2)
    assert.equal(
      calls.filter(c => c.args[0] === 'stapler' && c.args[1] === 'validate')
        .length,
      2
    )
    assert.equal(calls.filter(c => c.file === 'spctl').length, 2)
    assert.equal(keychains.length, 1)
    assert.equal(readdirSync(context.output).length, 0)
  })
  it('fails closed on missing configuration, rejected notarization, wrong identity or tooling failure', async () => {
    const config = context.settings.apps[id].macos!.apple!
    const signing: Signing = {
      directory: root,
      keychain: 'fixture',
      profiles: new Map()
    }
    config.architectures = ['arm64']
    await assert.rejects(packageMac(context, signing), /Universal/)
    config.architectures = ['arm64', 'x86_64']
    config.notarizationProfile = undefined
    await assert.rejects(notarize(context, 'example.zip'), /credentials/)
    config.notarizationProfile = 'fixture'
    response = JSON.stringify({ id: 'fixture', status: 'Invalid' })
    await assert.rejects(notarize(context, 'example.zip'), /not accept/)
    response = 'invalid'
    await assert.rejects(notarize(context, 'example.zip'))
    response = JSON.stringify({ id: 'fixture', status: 'Accepted' })
    config.notarizationKeychain = undefined
    details = 'TeamIdentifier=OTHER'
    await assert.rejects(packageMac(context, signing), /team/)
    rmSync(path.join(context.source, '.deploy-macos'), { recursive: true })
    details = 'TeamIdentifier=EXAMPLETEAM\nflags=0x10000(runtime)'
    config.teamId = 'OTHER'
    details = 'TeamIdentifier=OTHER\nflags=0x10000(runtime)'
    await assert.rejects(packageMac(context, signing), /certificate/)
    config.teamId = 'EXAMPLETEAM'
    rejectTool = 'xcodebuild'
    await assert.rejects(macos(context), /Tool failed/)
    assert.equal(keychains.length, 1)
  })
  it('handles nested frameworks and internal links but rejects links leaving the app', () => {
    const app = path.join(root, 'Example.app')
    const framework = path.join(app, 'Contents/Frameworks/Example.framework')
    file(
      path.join(framework, 'Versions/A/Example'),
      Buffer.from('cafebabe01020304', 'hex')
    )
    symlinkSync('A', path.join(framework, 'Versions/Current'))
    file(
      path.join(app, 'Contents/MacOS/Example'),
      Buffer.from('cffaedfe01020304', 'hex')
    )
    file(path.join(app, 'small'), 'a')
    const ordered = signingOrder(app)
    assert.equal(ordered.at(-1), app)
    assert(
      ordered.indexOf(path.join(framework, 'Versions/A/Example')) <
        ordered.indexOf(framework)
    )
    file(path.join(root, 'external'))
    symlinkSync(path.join(root, 'external'), path.join(app, 'escape'))
    assert.throws(() => signingOrder(app), /external symlink/)
  })
})
