import { execFile } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import { asObject, asString } from 'cleaners'

import { noSymlinks, runId } from '../state'
import { httpsOrigin, integer, object, sha, text } from '../validation'
import { asRemote, type Remote, validateLayout } from './config'
import { prepareOAuth } from './oauth'
import { caddyCandidate, caddySite, digest, service, timer } from './templates'

const asRequest = object({
  remote: asRemote,
  id: runId,
  commit: sha,
  archive: text(32 * 1024 * 1024),
  archiveDigest: sha,
  config: asObject({
    origin: httpsOrigin,
    database: asString,
    storage: asString,
    listenHost: asString,
    port: integer(1024, 65535)
  })
})
export type Exec = (
  file: string,
  args: string[],
  cwd?: string,
  input?: string
) => Promise<string>
export const execute: Exec = async (file, args, cwd, input) =>
  await new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        timeout: 600000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }
      },
      (error, stdout) => {
        if (error != null) reject(new Error('Remote deployment command failed'))
        else resolve(stdout.trim())
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
function atomic(file: string, value: string | Buffer, mode = 0o600): void {
  noSymlinks(file)
  const temporary = `${file}.new`
  noSymlinks(temporary)
  writeFileSync(temporary, value, { mode, flag: 'wx' })
  renameSync(temporary, file)
}
function snapshot(file: string): Buffer | undefined {
  noSymlinks(file)
  return existsSync(file) ? readFileSync(file) : undefined
}
function restore(file: string, before: Buffer | undefined, mode = 0o600): void {
  if (before == null) rmSync(file, { force: true })
  else atomic(file, before, mode)
}
async function ready(port: number, fetcher: typeof fetch): Promise<void> {
  for (let attempt = 0; attempt < 20; ++attempt) {
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(1000)
      })
      if (
        response.ok &&
        asObject({ status: asString })(await response.json()).status === 'ready'
      )
        return
    } catch {
      /* The service may still be starting. */
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Mason readiness failed')
}
async function ownership(
  remote: Remote,
  exec: Exec
): Promise<{ uid: number; gid: number }> {
  let account: string
  try {
    account = await exec('getent', ['passwd', remote.user])
  } catch {
    try {
      await exec('getent', ['group', remote.group])
    } catch {
      await exec('groupadd', ['--system', remote.group])
    }
    await exec('useradd', [
      '--system',
      '--no-create-home',
      '--home-dir',
      remote.root,
      '--shell',
      '/usr/sbin/nologin',
      '--gid',
      remote.group,
      remote.user
    ])
    account = await exec('getent', ['passwd', remote.user])
  }
  if (account.split(':')[5] !== remote.root)
    throw new Error('Service account is not dedicated to Mason')
  const uid = integer(1)(Number(await exec('id', ['-u', remote.user])))
  const group = (await exec('getent', ['group', remote.group])).split(':')
  const gid = integer(1)(Number(group[2]))
  return { uid, gid }
}
function configValue(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Mason configuration')
  return value as Record<string, unknown>
}
/** Runs on the destination host. All output is deliberately independent of private configuration. */
export async function deployRemote(
  value: unknown,
  exec: Exec = execute,
  fetcher: typeof fetch = fetch
): Promise<{ commit: string; ready: true }> {
  if (exec === execute && process.getuid?.() !== 0)
    throw new Error('Hosting requires an administrator on the destination')
  const request = asRequest(value)
  const remote = request.remote
  validateLayout(remote)
  const fullConfig = configValue(configValue(value).config)
  const root = remote.root
  const state = `${root}/state`
  const configFile = `${root}/config.json`
  const current = `${root}/current`
  if (
    request.config.database !== `${state}/mason.sqlite` ||
    request.config.storage !== `${state}/packages` ||
    request.config.listenHost !== '127.0.0.1' ||
    request.config.port !== remote.port
  )
    throw new Error(
      'Mason configuration must use its dedicated local state and listener'
    )
  const archive = Buffer.from(request.archive, 'base64')
  if (
    digest(archive) !== request.archiveDigest ||
    archive.length > 20 * 1024 * 1024
  )
    throw new Error('Invalid release archive')
  noSymlinks(root)
  if (
    existsSync(root) &&
    !existsSync(`${root}/.mason-hosting`) &&
    readdirSync(root).length !== 0
  )
    throw new Error('Unowned hosting directory')
  mkdirSync(root, { recursive: true, mode: 0o755 })
  if (!existsSync(`${root}/.mason-hosting`))
    atomic(`${root}/.mason-hosting`, 'mason-hosting-v1')
  if (snapshot(`${root}/.mason-hosting`)?.toString() !== 'mason-hosting-v1')
    throw new Error('Hosting ownership changed')
  noSymlinks(`${root}/hosting.sqlite`)
  const lock = new DatabaseSync(`${root}/hosting.sqlite`, { timeout: 100 })
  try {
    lock.exec('BEGIN EXCLUSIVE')
    if (existsSync(`${root}/transaction.json`))
      throw new Error(
        'An interrupted deployment requires recovery before another rollout'
      )
    const identity = await ownership(remote, exec)
    for (const directory of [
      state,
      `${root}/releases`,
      path.dirname(remote.caddyInclude)
    ]) {
      noSymlinks(directory)
      mkdirSync(directory, { recursive: true, mode: 0o755 })
    }
    chownSync(state, identity.uid, identity.gid)
    chmodSync(state, 0o700)
    const release = `${root}/releases/${request.commit}-${request.id}`
    if (existsSync(release))
      throw new Error(
        'Release already exists; choose a new source commit or recover the previous rollout'
      )
    mkdirSync(release, { mode: 0o755 })
    const archiveFile = `${release}/release.tgz`
    writeFileSync(archiveFile, archive, { mode: 0o600, flag: 'wx' })
    const entries = (await exec('tar', ['-tzf', archiveFile])).split('\n')
    if (
      entries.some(
        entry =>
          !/^(?:lib(?:\/[A-Za-z0-9_.-]+)*\/?|package(?:-lock)?\.json)$/.test(
            entry
          )
      )
    )
      throw new Error('Release archive contains unexpected paths')
    if (
      (await exec('tar', ['-tvzf', archiveFile]))
        .split('\n')
        .some(line => !/^[d-]/.test(line))
    )
      throw new Error('Release archive contains links')
    await exec('tar', ['-xzf', archiveFile, '--no-same-owner', '-C', release])
    function regularTree(dir: string): void {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name)
        if (item.isDirectory()) regularTree(file)
        else if (!item.isFile())
          throw new Error('Release must contain only regular files')
      }
    }
    regularTree(release)
    rmSync(archiveFile)
    await exec('chown', ['-R', `${remote.user}:${remote.group}`, release])
    await exec(
      'runuser',
      [
        '-u',
        remote.user,
        '--',
        'env',
        `PATH=${path.posix.dirname(remote.node)}:/usr/bin:/bin`,
        remote.npm,
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        `${release}/.npm-cache`
      ],
      release
    )
    await exec('chown', ['-R', '0:0', release])
    // Validate with the release's own cleaners before touching the running service.
    const nextConfig = `${root}/next-config.json`
    atomic(nextConfig, JSON.stringify(fullConfig))
    chownSync(nextConfig, identity.uid, identity.gid)
    await exec('runuser', [
      '-u',
      remote.user,
      '--',
      remote.node,
      '--input-type=module',
      '-e',
      'const {loadConfig}=await import(process.argv[1]);loadConfig(process.argv[2])',
      `file://${release}/lib/config.js`,
      nextConfig
    ])
    await prepareOAuth(remote, fullConfig, exec)
    const files = [
      configFile,
      remote.caddyFile,
      remote.caddyInclude,
      ...['.service', '-prune.service', '-prune.timer'].map(
        suffix => `${remote.systemdDirectory}/${remote.service}${suffix}`
      )
    ]
    const before = files.map(snapshot)
    if (before[1] == null) throw new Error('Missing live Caddy configuration')
    const live = before[1].toString()
    const candidate = caddyCandidate(live, remote, request.config.origin)
    const previous = existsSync(current) ? readlinkSync(current) : undefined
    if (
      previous != null &&
      (!previous.startsWith(`${root}/releases/`) ||
        !lstatSync(current).isSymbolicLink())
    )
      throw new Error('Current release ownership changed')
    const candidateFile = `${remote.caddyFile}.mason-candidate`
    const oldDatabase = `${root}/database-before.sqlite`
    const database = request.config.database
    let activated = false
    let stopped = false
    let databaseCopied = false
    let databaseChanged = false
    let liveWritten = false
    let exposed = false
    const maintenance = `${new URL(request.config.origin).host} {\n\tlog_skip\n\trespond "Temporarily unavailable" 503\n}\n`
    let includeWritten: Buffer | undefined
    let expectedCaddy = before[1]
    const replaceInclude = (data: string): void => {
      if (
        digest(snapshot(remote.caddyInclude) ?? Buffer.alloc(0)) !==
        digest(includeWritten ?? before[2] ?? Buffer.alloc(0))
      )
        throw new Error('Caddy include changed concurrently')
      atomic(remote.caddyInclude, data, 0o644)
      includeWritten = Buffer.from(data)
    }
    const checkLive = (): void => {
      if (
        digest(snapshot(remote.caddyFile) ?? Buffer.alloc(0)) !==
        digest(expectedCaddy)
      )
        throw new Error('Caddy configuration changed concurrently')
    }
    const reload = async (): Promise<void> => {
      await exec(remote.caddy, [
        'validate',
        '--config',
        remote.caddyFile,
        '--adapter',
        'caddyfile'
      ])
      await exec('systemctl', ['reload', remote.caddyService])
    }
    atomic(
      `${root}/transaction.json`,
      JSON.stringify({
        commit: request.commit,
        previous,
        files,
        before: before.map(data => data?.toString('base64') ?? null)
      })
    )
    try {
      replaceInclude(maintenance)
      atomic(candidateFile, candidate, 0o644)
      await exec(remote.caddy, [
        'validate',
        '--config',
        candidateFile,
        '--adapter',
        'caddyfile'
      ])
      checkLive()
      atomic(remote.caddyFile, candidate, 0o644)
      expectedCaddy = Buffer.from(candidate)
      liveWritten = true
      await exec('systemctl', ['reload', remote.caddyService])
      // Maintenance blocks requests before the database snapshot and the first migration.
      stopped = true
      if (previous != null)
        await exec('systemctl', [
          'stop',
          `${remote.service}-prune.timer`,
          `${remote.service}-prune.service`,
          `${remote.service}.service`
        ])
      noSymlinks(database)
      if (existsSync(database)) {
        const db = new DatabaseSync(database)
        try {
          writeFileSync(oldDatabase, '', { flag: 'wx', mode: 0o600 })
          await backup(db, oldDatabase)
        } finally {
          db.close()
        }
        chmodSync(oldDatabase, 0o600)
        databaseCopied = true
      }
      renameSync(nextConfig, configFile)
      databaseChanged = true
      await exec('runuser', [
        '-u',
        remote.user,
        '--',
        remote.node,
        `${release}/lib/cli.js`,
        'migrate',
        '--config',
        configFile
      ])
      for (const [i, data] of [
        service(remote),
        service(remote, true),
        timer(remote)
      ].entries())
        atomic(files[i + 3], data, 0o644)
      const next = `${current}.new`
      symlinkSync(release, next)
      renameSync(next, current)
      activated = true
      await exec('systemctl', ['daemon-reload'])
      await exec('systemctl', ['start', `${remote.service}.service`])
      await ready(remote.port, fetcher)
      await exec('systemctl', [
        'enable',
        '--now',
        `${remote.service}.service`,
        `${remote.service}-prune.timer`
      ])
      checkLive()
      replaceInclude(caddySite(request.config.origin, remote.port))
      await reload()
      exposed = true
      rmSync(`${root}/transaction.json`)
      rmSync(oldDatabase, { force: true })
      return { commit: request.commit, ready: true }
    } catch {
      if (exposed)
        throw new Error(
          'Release is live but cleanup failed; recovery journal may remain'
        )
      // Preserve a concurrent operator edit and the journal instead of overwriting it.
      checkLive()
      if (activated)
        await exec('systemctl', [
          'stop',
          `${remote.service}-prune.timer`,
          `${remote.service}-prune.service`,
          `${remote.service}.service`
        ])
      if (databaseChanged) {
        for (const suffix of ['', '-wal', '-shm']) {
          noSymlinks(database + suffix)
          rmSync(database + suffix, { force: true })
        }
        if (databaseCopied) {
          copyFileSync(oldDatabase, database)
          chownSync(database, identity.uid, identity.gid)
        }
      }
      for (const index of [0, 3, 4, 5])
        restore(files[index], before[index], index === 0 ? 0o600 : 0o644)
      if (before[0] != null) chownSync(configFile, identity.uid, identity.gid)
      if (activated) {
        rmSync(current)
        if (previous != null) symlinkSync(previous, current)
      }
      await exec('systemctl', ['daemon-reload'])
      if (previous != null && stopped)
        await exec('systemctl', [
          'start',
          `${remote.service}.service`,
          `${remote.service}-prune.timer`
        ])
      if (
        includeWritten != null &&
        digest(snapshot(remote.caddyInclude) ?? Buffer.alloc(0)) !==
          digest(includeWritten)
      )
        throw new Error(
          'Caddy include changed during rollback; recovery journal retained'
        )
      restore(remote.caddyInclude, before[2], 0o644)
      if (liveWritten) {
        restore(remote.caddyFile, before[1], 0o644)
        await reload()
      }
      rmSync(`${root}/transaction.json`)
      rmSync(oldDatabase, { force: true })
      throw new Error('Mason deployment failed and was rolled back')
    } finally {
      rmSync(candidateFile, { force: true })
      rmSync(nextConfig, { force: true })
    }
  } finally {
    lock.close()
  }
}
