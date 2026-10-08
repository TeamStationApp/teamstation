import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { loadSettings } from '../config'
import { fixtureSettings, testRoot } from '../config.test'
import { host, hostingOptions, ipv6Ready, main, shellQuote } from '../hosting'
import { type Command, Processes } from '../process'
import { gitFixture } from '../source.test'
import {
  asDns,
  asRemote,
  hostname,
  name,
  remotePath,
  validateLayout
} from './config'
import { DnsRecords } from './dns'
import { prepareOAuth } from './oauth'
import { deployRemote, type Exec, execute } from './remote'
import {
  blocks,
  buildRedirect,
  caddyCandidate,
  caddySite,
  digest,
  oauthRoutes,
  service,
  timer
} from './templates'

let root: string
export function fixtureRemote(root: string): ReturnType<typeof asRemote> {
  return asRemote({
    root: `${root}/mason`,
    node: '/usr/bin/node',
    npm: '/usr/bin/npm',
    user: 'distribution',
    group: 'distribution',
    service: 'distribution',
    systemdDirectory: `${root}/units`,
    caddyFile: `${root}/Caddyfile`,
    caddyInclude: `${root}/includes/mason.caddy`,
    caddy: process.env.CADDY_BINARY ?? '/opt/homebrew/bin/caddy',
    caddyService: 'web',
    protectedPaths: [`${root}/application`],
    teamstationOrigin: 'https://app.example.test',
    teamstationSnippet: 'application',
    port: 19547,
    memoryBytes: 512 * 1024 ** 2,
    tasks: 128
  })
}
const live = `(application) {\n\thandle /api/* {\n\t\treverse_proxy 127.0.0.1:{args[0]}\n\t}\n\thandle {\n\t\trespond "web shell"\n\t}\n}\napp.example.test {\n\thandle /builds/* {\n\t\trespond "old builds"\n\t}\n\thandle /downloads/* {\n\t\trespond "keep me"\n\t}\n\timport application 19100\n}\n# unrelated live drift\nother.example.test {\n\trespond "preserved"\n}\n`
const origin = 'https://builds.example.test'
function privateWrite(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
}
function requestFixture(): {
  request: Parameters<typeof deployRemote>[0] & Record<string, any>
  remote: ReturnType<typeof asRemote>
  exec: Exec
  calls: string[]
} {
  const remote = fixtureRemote(root)
  mkdirSync(remote.systemdDirectory)
  writeFileSync(remote.caddyFile, live)
  const packageDir = `${root}/package`
  mkdirSync(`${packageDir}/lib`, { recursive: true })
  writeFileSync(`${packageDir}/lib/cli.js`, 'export {}')
  privateWrite(`${packageDir}/package.json`, {
    name: 'fixture',
    version: '1.0.0'
  })
  privateWrite(`${packageDir}/package-lock.json`, {})
  execFileSync('tar', [
    '-czf',
    `${root}/release.tgz`,
    '-C',
    packageDir,
    'lib',
    'package.json',
    'package-lock.json'
  ])
  const archive = readFileSync(`${root}/release.tgz`)
  const request = {
    remote,
    id: randomBytes(16).toString('hex'),
    commit: 'a'.repeat(40),
    archive: archive.toString('base64'),
    archiveDigest: digest(archive),
    config: {
      origin,
      database: `${remote.root}/state/mason.sqlite`,
      storage: `${remote.root}/state/packages`,
      listenHost: '127.0.0.1',
      port: remote.port,
      providers: []
    }
  }
  const calls: string[] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args].join(' '))
    if (file === 'id') return String(process.getuid?.())
    if (file === 'getent')
      return args[0] === 'passwd'
        ? `distribution:x:501:20::${remote.root}:/usr/sbin/nologin`
        : `distribution:x:${process.getgid?.()}:`
    if (file === 'tar')
      return execFileSync(file, args, { encoding: 'utf8' }).trim()
    if (file === remote.caddy)
      return execFileSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    if (args.includes('migrate')) {
      const db = new DatabaseSync(request.config.database)
      db.exec(
        "CREATE TABLE IF NOT EXISTS events(value TEXT); INSERT INTO events VALUES('migration')"
      )
      db.close()
    }
    return ''
  }
  return { request, remote, exec, calls }
}
const healthy: typeof fetch = async () =>
  new Response(JSON.stringify({ status: 'ready' }))
describe('Standalone distribution hosting', function () {
  this.timeout(20000)
  beforeEach(() => {
    root = testRoot('hosting-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('validates private layout, names, addresses and unit resource boundaries', () => {
    for (const invalid of ['/a/../b', '/', '/a b', '/a%H', 'relative'])
      assert.throws(() => remotePath(invalid))
    for (const invalid of ['ROOT', 'foo.bar', '../x', 'x;id'])
      assert.throws(() => name(invalid))
    for (const invalid of ['-bad', 'two..dots', 'host:22'])
      assert.throws(() => hostname(invalid))
    const remote = fixtureRemote(root)
    validateLayout(remote)
    assert.throws(() => {
      validateLayout({ ...remote, protectedPaths: [] })
    })
    assert.throws(() => {
      validateLayout({ ...remote, user: 'root' })
    })
    assert.throws(() => {
      validateLayout({ ...remote, root })
    })
    assert.throws(() =>
      asDns({
        domain: 'example.test',
        name: 'builds',
        address: '::1',
        tokenFile: 'token'
      })
    )
    assert.throws(() =>
      asDns({
        domain: 'example.test',
        name: 'builds',
        address: '192.0.2.1',
        ipv6: 'wrong',
        tokenFile: 'token'
      })
    )
    assert.match(service(remote), /ProtectSystem=strict/)
    assert.match(service(remote, true), /Type=oneshot/)
    assert.match(timer(remote), /Persistent=true/)
    assert.match(caddySite(origin, 19100), /log_skip/)
    assert.match(buildRedirect(origin), /302/)
    assert.match(oauthRoutes, /not path_regexp \^\/oauth\/approve/)
    assert.equal(shellQuote("one'two"), "'one'\\''two'")
    assert.deepEqual(hostingOptions(['--branch', 'feature/demo']), {
      file: 'deployConfig.json',
      branch: 'feature/demo',
      dryRun: false
    })
    for (const args of [
      [],
      ['--bad'],
      ['--branch'],
      ['--branch', 'master', '--branch', 'a'],
      ['--config', '--dry-run']
    ])
      assert.throws(() => hostingOptions(args))
  })
  it('preserves unrelated live Caddy bytes, validates the candidate and is idempotent', () => {
    const remote = fixtureRemote(root)
    mkdirSync(path.dirname(remote.caddyInclude))
    writeFileSync(remote.caddyInclude, caddySite(origin, remote.port))
    const result = caddyCandidate(live, remote, origin)
    assert(result.includes('# unrelated live drift\nother.example.test'))
    assert(result.includes('respond "keep me"'))
    assert(!result.includes('old builds'))
    assert.equal(caddyCandidate(result, remote, origin), result)
    const upgraded = caddyCandidate(
      result.replace(
        '\theader @masonAuthLog Referrer-Policy no-referrer\n',
        ''
      ),
      remote,
      origin
    )
    assert(
      upgraded.includes('header @masonAuthLog Referrer-Policy no-referrer')
    )
    assert.equal(caddyCandidate(upgraded, remote, origin), upgraded)
    writeFileSync(remote.caddyFile, result)
    execFileSync(
      remote.caddy,
      ['validate', '--config', remote.caddyFile, '--adapter', 'caddyfile'],
      { stdio: 'pipe' }
    )
    for (const value of ['}', 'a {\n', '"unclosed'])
      assert.throws(() => blocks(value))
    assert.equal(
      blocks('a {\n # } ignored\n respond "escaped \\" brace {"\n}\n').length,
      1
    )
    assert.throws(() => caddyCandidate('other {\n}\n', remote, origin))
    assert.throws(() =>
      caddyCandidate(
        result.replace(`redir ${origin}/`, 'redir https://other.example.test/'),
        remote,
        origin
      )
    )
    assert(
      caddyCandidate(
        live.replace('handle /builds/*', 'handle /other/*'),
        remote,
        origin
      ).includes('@masonLegacyBuilds')
    )
  })
  it('creates only missing DNS records, rejects conflicts and guards rollback ownership', async () => {
    const config = asDns({
      domain: 'example.test',
      name: 'builds',
      address: '192.0.2.12',
      ipv6: '2001:db8::12',
      tokenFile: 'token.json'
    })
    let records: Array<{
      id: number
      type: string
      name: string
      data: string
    }> = [{ id: 1, type: 'TXT', name: 'unrelated', data: 'preserved' }]
    const requests: string[] = []
    const fetcher: typeof fetch = async (url, init) => {
      const address =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      requests.push(`${init?.method} ${address}`)
      if (init?.method === 'POST') {
        const record = {
          id: records.length + 1,
          ...JSON.parse(init.body as string)
        }
        records.push(record)
        return Response.json({ domain_record: record })
      }
      if (init?.method === 'DELETE') {
        records = records.filter(r => !address.endsWith(`/${r.id}`))
        return new Response(null, { status: 204 })
      }
      return Response.json({ domain_records: records })
    }
    const dns = new DnsRecords(config, 'synthetic', fetcher)
    const id = await dns.ensure('A')
    assert.equal(id, 2)
    assert.equal(await dns.ensure('A'), undefined)
    await assert.rejects(dns.ensure('AAAA'), /verified/)
    assert.equal(await dns.ensure('AAAA', true), 3)
    records[1].data = '192.0.2.13'
    await assert.rejects(dns.rollback(2, 'A'), /changed/)
    await assert.rejects(dns.ensure('A'), /Conflicting/)
    records[1].data = config.address
    await dns.rollback(2, 'A')
    await dns.rollback(2, 'A')
    assert.equal(records[0].data, 'preserved')
    records.push({
      id: 4,
      type: 'CNAME',
      name: 'builds',
      data: 'other.example.test'
    })
    await assert.rejects(dns.ensure('A'), /Conflicting/)
    assert(requests.some(r => r.startsWith('POST')))
    await assert.rejects(
      new DnsRecords(
        config,
        's',
        async () => new Response('', { status: 401 })
      ).records()
    )
    await assert.rejects(
      new DnsRecords(config, 's', async () => new Response(null)).records()
    )
    await assert.rejects(
      new DnsRecords(config, 's', async () =>
        Response.json({
          domain_records: [],
          links: { pages: { next: 'more' } }
        })
      ).records(),
      /Too many/
    )
  })
  it('stages and activates a release through real archive extraction, Caddy validation and SQLite', async () => {
    const { request, remote, exec, calls } = requestFixture()
    const result = await deployRemote(request, exec, healthy)
    assert.equal(result.commit, request.commit)
    assert.equal(result.ready, true)
    assert(readlinkSync(`${remote.root}/current`).endsWith(request.id))
    assert(!existsSync(`${remote.root}/transaction.json`))
    assert.equal(lstatSync(`${remote.root}/config.json`).mode & 0o777, 0o600)
    assert.match(readFileSync(remote.caddyFile, 'utf8'), /masonLegacyBuilds/)
    assert(
      calls.findIndex(c => c.includes('reload web')) <
        calls.findIndex(c => c.includes(' migrate '))
    )
    assert(
      calls.some(c =>
        c.includes('enable --now distribution.service distribution-prune.timer')
      )
    )
    const db = new DatabaseSync(request.config.database)
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()?.n, 1)
    db.close()
  })
  it('does not replace the database when creating its rollback snapshot fails', async () => {
    const { request, remote, exec } = requestFixture()
    await deployRemote(request, exec, healthy)
    request.id = randomBytes(16).toString('hex')
    writeFileSync(
      `${remote.root}/database-before.sqlite`,
      'unfinished snapshot',
      { mode: 0o600 }
    )
    await assert.rejects(deployRemote(request, exec, healthy), /rolled back/)
    const db = new DatabaseSync(request.config.database)
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()?.n, 1)
    db.close()
  })
  it('restores database, active release and configuration after a failed migration', async () => {
    const { request, remote, exec } = requestFixture()
    await deployRemote(request, exec, healthy)
    const previous = readlinkSync(`${remote.root}/current`)
    const previousConfig = readFileSync(`${remote.root}/config.json`)
    const previousCaddy = readFileSync(remote.caddyFile)
    request.id = randomBytes(16).toString('hex')
    request.commit = 'b'.repeat(40)
    const fail: Exec = async (file, args, ...rest) => {
      const result = await exec(file, args, ...rest)
      if (args.includes('migrate')) throw new Error('fixture migration failure')
      return result
    }
    await assert.rejects(deployRemote(request, fail, healthy), /rolled back/)
    assert.equal(readlinkSync(`${remote.root}/current`), previous)
    assert.deepEqual(readFileSync(`${remote.root}/config.json`), previousConfig)
    assert.deepEqual(readFileSync(remote.caddyFile), previousCaddy)
    const db = new DatabaseSync(request.config.database)
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()?.n, 1)
    db.close()
  })
  it('rolls back first-install readiness failures and preserves concurrent Caddy edits for recovery', async () => {
    const { request, remote, exec } = requestFixture()
    await assert.rejects(
      deployRemote(request, exec, async () => {
        throw new Error('unavailable')
      }),
      /rolled back/
    )
    assert(!existsSync(`${remote.root}/current`))
    assert(!existsSync(request.config.database))
    assert.equal(readFileSync(remote.caddyFile, 'utf8'), live)
    request.id = randomBytes(16).toString('hex')
    const concurrent: Exec = async (file, args, ...rest) => {
      const result = await exec(file, args, ...rest)
      if (args.includes('validate'))
        writeFileSync(remote.caddyFile, live + '\n# concurrent operator edit\n')
      return result
    }
    await assert.rejects(
      deployRemote(request, concurrent, healthy),
      /concurrently/
    )
    assert.match(readFileSync(remote.caddyFile, 'utf8'), /concurrent operator/)
    assert(existsSync(`${remote.root}/transaction.json`))
    await assert.rejects(deployRemote(request, exec, healthy), /interrupted/)
  })
  it('rejects invalid archives and an overlapping or unowned destination before mutation', async () => {
    const { request, remote, exec } = requestFixture()
    await assert.rejects(
      deployRemote(
        { ...request, archiveDigest: 'b'.repeat(64) },
        exec,
        healthy
      ),
      /archive/
    )
    await assert.rejects(
      deployRemote(
        { ...request, config: { ...request.config, listenHost: '0.0.0.0' } },
        exec,
        healthy
      ),
      /dedicated/
    )
    mkdirSync(remote.root)
    writeFileSync(`${remote.root}/unrelated`, 'keep')
    await assert.rejects(deployRemote(request, exec, healthy), /Unowned/)
    assert.equal(readFileSync(`${remote.root}/unrelated`, 'utf8'), 'keep')
    assert.equal(
      await execute(process.execPath, ['-e', 'process.stdout.write("ok")']),
      'ok'
    )
    await assert.rejects(execute(process.execPath, ['-e', 'process.exit(2)']))
  })
  it('prepares provider secrets and a private candidate without changing the active TeamStation configuration', async () => {
    const remote = fixtureRemote(root)
    remote.oauth = {
      serverConfigFile: `${root}/server.json`,
      signingKeysFile: `${root}/signing.json`,
      storageKeyFile: `${root}/storage.txt`,
      cookieKeysFile: `${root}/cookies.json`,
      user: 'application',
      group: 'application',
      providerId: 'application',
      clientName: 'Distribution'
    }
    privateWrite(remote.oauth.serverConfigFile, { existing: 'preserved' })
    const mason = {
      origin,
      providers: [
        {
          id: 'application',
          type: 'oidc',
          issuer: `${remote.teamstationOrigin}/oauth`,
          clientId: 'distribution',
          clientSecret: 's'.repeat(32)
        }
      ]
    }
    const exec: Exec = async file =>
      file === 'id'
        ? String(process.getuid?.())
        : `application:x:${process.getgid?.()}:`
    await prepareOAuth(remote, mason, exec)
    await prepareOAuth(remote, mason, exec)
    assert.deepEqual(
      JSON.parse(readFileSync(remote.oauth.serverConfigFile, 'utf8')),
      { existing: 'preserved' }
    )
    const next = JSON.parse(
      readFileSync(
        remote.oauth.serverConfigFile + '.mason-candidate.json',
        'utf8'
      )
    )
    assert.equal(next.buildsUrl, origin)
    assert.equal(
      next.oauth.clients[0].redirectUris[0],
      origin + '/auth/callback/application'
    )
    assert.equal(lstatSync(remote.oauth.signingKeysFile).mode & 0o777, 0o600)
    await assert.rejects(
      prepareOAuth(remote, { ...mason, providers: [] }, exec),
      /does not match/
    )
    chmodSync(remote.oauth.storageKeyFile, 0o644)
    await assert.rejects(prepareOAuth(remote, mason, exec), /not private/)
    await prepareOAuth({ ...remote, oauth: undefined }, {}, exec)
  })
  it('loads hosting inheritance, validates dry-run and handles CLI errors without exposing configuration', async () => {
    const settings = fixtureSettings(root) as Record<string, unknown>
    const remote = fixtureRemote(root)
    const file = `${root}/deployConfig.json`
    const mason = `${root}/mason.json`
    const key = `${root}/identity`
    const known = `${root}/known_hosts`
    writeFileSync(key, 'synthetic', { mode: 0o600 })
    writeFileSync(known, 'fixture known host')
    privateWrite(mason, { origin })
    settings.hosting = {
      repository: 'source',
      branch: 'master',
      configFile: mason,
      ssh: {
        host: 'host.example.test',
        user: 'operator',
        port: 22,
        identityFile: key,
        knownHostsFile: known
      },
      remote,
      dns: {
        domain: 'example.test',
        name: 'builds',
        address: '192.0.2.12',
        tokenFile: 'dns.json'
      }
    }
    privateWrite(file, { schemaVersion: 1, branches: { master: { settings } } })
    const resolved = loadSettings(file, 'feature/test')
    assert.equal(resolved.hosting?.dns?.tokenFile, `${root}/dns.json`)
    const output: string[] = []
    await host(
      ['--config', file, '--branch', 'master', '--dry-run'],
      new Processes(new AbortController().signal),
      value => output.push(value)
    )
    assert(output[0].includes('No changes'))
    const previous = console.error
    console.error = () => {}
    try {
      assert.equal(await main(['--bad']), 1)
    } finally {
      console.error = previous
    }
    chmodSync(key, 0o644)
    await assert.rejects(
      host(
        ['--config', file, '--branch', 'master'],
        new Processes(new AbortController().signal)
      ),
      /private/
    )
  })
  it('pins a real Git source and carries a private release through the SSH orchestration boundary', async () => {
    const { request, remote, exec } = requestFixture()
    gitFixture(root)
    const settings = fixtureSettings(root) as Record<string, unknown>
    const file = `${root}/deployConfig.json`
    const mason = `${root}/mason.json`
    const key = `${root}/identity`
    const known = `${root}/known_hosts`
    writeFileSync(key, 'synthetic', { mode: 0o600 })
    writeFileSync(known, 'fixture')
    privateWrite(mason, request.config)
    settings.hosting = {
      repository: 'source',
      branch: 'master',
      configFile: mason,
      ssh: {
        host: 'host.example.test',
        user: 'operator',
        port: 22,
        identityFile: key,
        knownHostsFile: known
      },
      remote
    }
    privateWrite(file, { schemaVersion: 1, branches: { master: { settings } } })
    let sshCalls = 0
    class Harness extends Processes {
      override async run(command: Command): Promise<string> {
        if (command.file === 'socket') return ''
        if (command.file === 'npm') {
          mkdirSync(`${command.cwd}/lib/nested`, { recursive: true })
          writeFileSync(`${command.cwd}/lib/nested/fixture.js`, 'export {}')
          writeFileSync(`${command.cwd}/package-lock.json`, '{}')
          if (process.platform === 'darwin')
            execFileSync('xattr', [
              '-w',
              'user.fixture',
              'metadata',
              `${command.cwd}/package.json`
            ])
          return ''
        }
        if (command.file === 'ssh') {
          ++sshCalls
          assert(command.args.includes('StrictHostKeyChecking=yes'))
          assert(!command.args.join(' ').includes('providers'))
          const input = JSON.parse(command.input!)
          const tar = gunzipSync(Buffer.from(input.request.archive, 'base64'))
          for (let offset = 0; offset + 512 <= tar.length;) {
            const name = tar
              .subarray(offset, offset + 100)
              .toString()
              .split('\0')[0]
            if (name === '') break
            assert(!name.split('/').some(part => part.startsWith('._')), name)
            const size = parseInt(
              tar.subarray(offset + 124, offset + 136).toString(),
              8
            )
            assert(Number.isFinite(size))
            offset += 512 + Math.ceil(size / 512) * 512
          }
          assert.equal(input.program.includes('deployRemote'), true)
          return JSON.stringify(
            await deployRemote(input.request, exec, healthy)
          )
        }
        return await super.run(command)
      }
    }
    const output: string[] = []
    await host(
      ['--config', file, '--branch', 'master'],
      new Harness(new AbortController().signal),
      text => output.push(text)
    )
    assert.equal(sshCalls, 1)
    assert.match(output[0], /is ready/)
    assert.equal(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: `${root}/source`,
        encoding: 'utf8'
      }).split('worktree ').length,
      2
    )
    const cli = spawnSync(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        'scripts/deploy/hosting.ts',
        '--config',
        file,
        '--branch',
        'master',
        '--dry-run'
      ],
      { encoding: 'utf8' }
    )
    assert.equal(cli.status, 0, cli.stderr)
    assert.match(cli.stdout, /No changes/)
    assert.equal(
      await main(['--config', file, '--branch', 'master', '--dry-run']),
      0
    )
    await assert.rejects(
      ipv6Ready('https://localhost:1', '::1'),
      /IPv6 readiness failed/
    )
    const link = `${root}/key-link`
    symlinkSync(key, link)
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.branches.master.settings.hosting.ssh.identityFile = link
    privateWrite(file, config)
    await assert.rejects(
      host(
        ['--config', file, '--branch', 'master'],
        new Harness(new AbortController().signal)
      ),
      /regular/
    )
  })
})
