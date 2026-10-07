import { X509Certificate } from 'node:crypto'
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  symlinkSync
} from 'node:fs'
import path from 'node:path'

import { asObject } from 'cleaners'

import { archive, type Signing, verifyApp, withSigning } from './apple'
import { type BuildContext, type BuiltPackage, nativeNumber } from './runner'
import { text } from './validation'

/** Sign innermost code before the bundles that seal it. Framework links stay inside the app. */
export function signingOrder(app: string): string[] {
  const root = realpathSync(app)
  const result: string[] = []
  function visit(file: string): void {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(file)
      if (!resolved.startsWith(root + path.sep))
        throw new Error('App contains an external symlink')
      return
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(file)) visit(path.join(file, name))
      if (/\.(app|framework|xpc|appex)$/.test(file)) result.push(file)
    } else if (stat.isFile() && stat.size >= 4) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const bytes = Buffer.alloc(4)
      try {
        readSync(fd, bytes, 0, 4, 0)
      } finally {
        closeSync(fd)
      }
      if (
        [
          'feedface',
          'feedfacf',
          'cefaedfe',
          'cffaedfe',
          'cafebabe',
          'bebafeca',
          'cafebabf',
          'bfbafeca'
        ].includes(bytes.toString('hex'))
      )
        result.push(file)
    }
  }
  visit(root)
  return result
}
export async function notarize(
  context: BuildContext,
  file: string
): Promise<void> {
  const config = context.settings.apps[context.target.app].macos?.apple
  if (config?.notarizationProfile == null)
    throw new Error('Notarization credentials are required')
  const result = asObject({ id: text(128), status: text(128) })(
    JSON.parse(
      await context.processes.run({
        file: context.settings.tools.xcrun,
        args: [
          'notarytool',
          'submit',
          file,
          '--keychain-profile',
          config.notarizationProfile,
          ...(config.notarizationKeychain == null
            ? []
            : ['--keychain', config.notarizationKeychain]),
          '--wait',
          '--timeout',
          '60m',
          '--output-format',
          'json'
        ],
        cwd: context.source
      })
    )
  )
  if (result.status !== 'Accepted')
    throw new Error('Apple did not accept notarization')
}
async function ticket(context: BuildContext, file: string): Promise<void> {
  for (const action of ['staple', 'validate'])
    await context.processes.run({
      file: context.settings.tools.xcrun,
      args: ['stapler', action, file],
      cwd: context.source
    })
}
export async function packageMac(
  context: BuildContext,
  signing: Signing
): Promise<BuiltPackage> {
  const config = context.settings.apps[context.target.app].macos?.apple
  if (
    config?.notarizationProfile == null ||
    !config.architectures.includes('arm64') ||
    !config.architectures.includes('x86_64') ||
    !config.identity.startsWith('Developer ID Application:')
  )
    throw new Error(
      'Universal Developer ID signing and notarization are required'
    )
  const archived = await archive(context, signing)
  const applications = path.join(archived, 'Products/Applications')
  const names = readdirSync(applications).filter(name => name.endsWith('.app'))
  if (names.length !== 1)
    throw new Error('Expected one archived macOS application')
  const staged = path.join(context.source, '.deploy-macos')
  mkdirSync(staged, { mode: 0o700 })
  const app = path.join(staged, names[0])
  await context.processes.run({
    file: 'ditto',
    args: [path.join(applications, names[0]), app],
    cwd: context.source
  })
  for (const code of signingOrder(app))
    await context.processes.run({
      file: context.settings.tools.codesign,
      args: [
        '--force',
        '--sign',
        config.identity,
        '--keychain',
        signing.keychain,
        '--timestamp',
        '--options',
        'runtime',
        '--preserve-metadata=entitlements,requirements',
        code
      ],
      cwd: context.source
    })
  await verifyApp(context, app, signing)
  const details = await context.processes.run({
    file: context.settings.tools.codesign,
    args: ['-d', '--verbose=4', app],
    cwd: context.source,
    captureStderr: true
  })
  if (
    !details.includes(`TeamIdentifier=${config.teamId}`) ||
    !/flags=.*\(runtime\)/.test(details)
  )
    throw new Error('App lacks the expected team or hardened runtime')
  const cert = path.join(signing.directory, 'developer-id')
  await context.processes.run({
    file: context.settings.tools.codesign,
    args: ['-d', '--extract-certificates', cert, app],
    cwd: context.source
  })
  const leaf = new X509Certificate(readFileSync(cert + '0'))
  if (
    !leaf.subject.split('\n').includes(`OU=${config.teamId}`) ||
    !leaf.subject
      .split('\n')
      .some(line => line.startsWith('CN=Developer ID Application:')) ||
    Date.parse(leaf.validTo) <= Date.now() ||
    Date.parse(leaf.validFrom) > Date.now()
  )
    throw new Error('Developer ID certificate is invalid')
  const zip = path.join(signing.directory, 'application.zip')
  await context.processes.run({
    file: 'ditto',
    args: ['-c', '-k', '--keepParent', app, zip],
    cwd: context.source
  })
  await notarize(context, zip)
  await ticket(context, app)
  await context.processes.run({
    file: 'spctl',
    args: ['--assess', '--type', 'execute', app],
    cwd: context.source
  })
  symlinkSync('/Applications', path.join(staged, 'Applications'))
  const dmg = path.join(context.source, 'distribution.dmg')
  await context.processes.run({
    file: context.settings.tools.hdiutil,
    args: [
      'create',
      '-volname',
      'Application',
      '-srcfolder',
      staged,
      '-format',
      'UDZO',
      dmg
    ],
    cwd: context.source,
    capture: false
  })
  await context.processes.run({
    file: context.settings.tools.codesign,
    args: [
      '--sign',
      config.identity,
      '--keychain',
      signing.keychain,
      '--timestamp',
      dmg
    ],
    cwd: context.source
  })
  await notarize(context, dmg)
  await ticket(context, dmg)
  await context.processes.run({
    file: context.settings.tools.codesign,
    args: ['--verify', '--strict', dmg],
    cwd: context.source
  })
  await context.processes.run({
    file: 'spctl',
    args: [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      dmg
    ],
    cwd: context.source
  })
  return { file: dmg, buildNumber: nativeNumber('macos', context.buildNumber) }
}
export async function macos(context: BuildContext): Promise<BuiltPackage> {
  return await withSigning(
    context,
    async signing => await packageMac(context, signing)
  )
}
