import { randomBytes } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { asObject } from 'cleaners'
import { build } from 'esbuild'

import { loadSettings, privateJson } from './config'
import { validateLayout } from './hosting/config'
import { DnsRecords } from './hosting/dns'
import { digest } from './hosting/templates'
import { Processes } from './process'
import { prepareRepository } from './source'
import { State } from './state'
import { branchName, httpsOrigin, object, sha, text } from './validation'

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
export async function ipv6Ready(
  origin: string,
  address: string
): Promise<void> {
  const url = new URL('/health', origin)
  await new Promise<void>((resolve, reject) => {
    const request = https.get(
      url,
      {
        hostname: address,
        servername: url.hostname,
        headers: { host: url.host },
        timeout: 10000
      },
      response => {
        response.resume()
        if (response.statusCode === 200) resolve()
        else reject(new Error('IPv6 readiness failed'))
      }
    )
    request.on('timeout', () =>
      request.destroy(new Error('IPv6 probe timed out'))
    )
    request.on('error', () => {
      reject(new Error('IPv6 readiness failed'))
    })
  })
}
export function hostingOptions(args: string[]): {
  file: string
  branch: string
  dryRun: boolean
} {
  let file = 'deployConfig.json'
  let branch: string | undefined
  let dryRun = false
  const seen = new Set<string>()
  for (let i = 0; i < args.length; ++i) {
    const flag = args[i]
    if (seen.has(flag)) throw new Error('Duplicate option')
    seen.add(flag)
    if (flag === '--dry-run') dryRun = true
    else if (
      (flag === '--config' || flag === '--branch') &&
      args[i + 1] != null &&
      !args[i + 1].startsWith('--')
    ) {
      const value = args[++i]
      if (flag === '--config') file = value
      else branch = branchName(value)
    } else throw new Error('Invalid hosting option')
  }
  if (branch == null) throw new Error('Branch is required')
  return { file, branch, dryRun }
}
export async function host(
  args: string[],
  processes: Processes,
  output: (text: string) => void = console.log
): Promise<void> {
  const options = hostingOptions(args)
  const settings = loadSettings(options.file, options.branch)
  const hosting = settings.hosting
  if (hosting == null) throw new Error('Hosting is not configured')
  validateLayout(hosting.remote)
  const config = privateJson(hosting.configFile, (value: unknown) => {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid Mason config')
    asObject({ origin: httpsOrigin })(value)
    return value
  })
  const { origin } = asObject({ origin: httpsOrigin })(config)
  if (
    hosting.dns != null &&
    `${hosting.dns.name}.${hosting.dns.domain}` !== new URL(origin).hostname
  )
    throw new Error('DNS target must match the Mason origin')
  for (const file of [hosting.ssh.identityFile, hosting.ssh.knownHostsFile])
    if (!lstatSync(file).isFile())
      throw new Error('SSH identity and known hosts must be regular files')
  if ((lstatSync(hosting.ssh.identityFile).mode & 0o077) !== 0)
    throw new Error('SSH private key is not private')
  const remote = hosting.remote
  if (options.dryRun) {
    output('Mason hosting configuration is valid. No changes made.')
    return
  }
  const state = new State(settings.stateDirectory)
  try {
    const id = randomBytes(16).toString('hex')
    const source = await prepareRepository(
      settings,
      hosting.repository,
      'package.json',
      hosting.branch,
      id,
      processes
    )
    try {
      await processes.run({
        file: settings.tools.socket,
        args: ['npm', 'ci', '--ignore-scripts'],
        cwd: source.directory,
        capture: false
      })
      await processes.run({
        file: settings.tools.npm,
        args: ['run', 'build'],
        cwd: source.directory,
        capture: false
      })
      function regular(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) regular(path.join(dir, entry.name))
          else if (!entry.isFile())
            throw new Error('Release contains a symlink')
        }
      }
      regular(path.join(source.directory, 'lib'))
      const archiveFile = path.join(source.directory, 'mason-release.tgz')
      await processes.run({
        file: 'tar',
        args: ['-czf', archiveFile, 'lib', 'package.json', 'package-lock.json'],
        cwd: source.directory
      })
      const archive = readFileSync(archiveFile)
      if (archive.length > 20 * 1024 * 1024)
        throw new Error('Mason release is too large')
      const bundle = await build({
        entryPoints: [path.join(__dirname, 'hosting/remote.ts')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        write: false,
        logLevel: 'silent'
      })
      const program = bundle.outputFiles[0].text
      const bootstrap = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{input+=v;if(input.length>40000000)process.exit(1)});process.stdin.on('end',async()=>{try{const{program,request}=JSON.parse(input);const m=new(require('node:module'))();m.paths=module.paths;m._compile(program,'mason-hosting.cjs');console.log(JSON.stringify(await m.exports.deployRemote(request)))}catch{console.error('Remote rollout failed. Inspect the private recovery journal before retrying.');process.exitCode=1}})`
      const ssh = hosting.ssh
      const sshArgs = [
        '-T',
        '-p',
        String(ssh.port),
        '-i',
        ssh.identityFile,
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${ssh.knownHostsFile}`,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=4',
        `${ssh.user}@${ssh.host}`,
        `${shellQuote(remote.node)} -e ${shellQuote(bootstrap)}`
      ]
      let dns: DnsRecords | undefined
      if (hosting.dns != null) {
        const token = privateJson(
          hosting.dns.tokenFile,
          object({ token: text() })
        ).token
        dns = new DnsRecords(hosting.dns, token)
        await dns.ensure('A')
      }
      // A transport failure has an unknown remote outcome. Preserve DNS for recovery.
      const response = await processes.run({
        file: 'ssh',
        args: sshArgs,
        cwd: source.directory,
        input: JSON.stringify({
          program,
          request: {
            remote,
            id,
            commit: source.commit,
            archive: archive.toString('base64'),
            archiveDigest: digest(archive),
            config
          }
        })
      })
      const result = object({
        commit: sha,
        ready: (v: unknown): true => {
          if (v !== true) throw new Error('Mason is not ready')
          return true
        }
      })(JSON.parse(response))
      if (result.commit !== source.commit)
        throw new Error('Unexpected deployed release')
      if (dns != null && hosting.dns?.ipv6 != null) {
        await ipv6Ready(origin, hosting.dns.ipv6)
        await dns.ensure('AAAA', true)
      }
      output(`Mason release ${result.commit} is ready.`)
    } finally {
      await source.cleanup()
    }
  } finally {
    state.close()
  }
}
export async function main(args: string[]): Promise<number> {
  const cancel = new AbortController()
  const stop = (): void => {
    cancel.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await host(args, new Processes(cancel.signal))
    return 0
  } catch {
    console.error(
      'Hosting failed. Check the private configuration and recovery journal. Usage: npm run deploy:hosting -- --branch <branch> [--config <file>] [--dry-run]'
    )
    return 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
if (require.main === module)
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      process.exitCode = 1
    })
