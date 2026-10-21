import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { sql } from 'kysely'
import { it } from 'mocha'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { accountHarness } from '../../test/accountHarness'
import { createScoringGame, userMinter } from '../dev/scoringGame'
const execute = promisify(execFile)
it('starts the production router and keeps development season creators compatible with required dates', async function () {
  this.timeout(60000)
  const h = await accountHarness()
  const folder = await mkdtemp(join(tmpdir(), 'umpire-startup-'))
  const dbName = (
    await sql<{ name: string }>`select current_database() as name`.execute(h.db)
  ).rows[0].name
  const databaseUrl = new URL(testDatabaseUrl)
  databaseUrl.pathname = '/' + dbName
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const addr = probe.address()
  if (addr == null || typeof addr === 'string') throw new Error('No test port')
  const port = addr.port
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  const config = {
    databaseUrl: databaseUrl.toString(),
    listenPort: port,
    clusterWorkers: 1,
    statsBuilder: false,
    live: { enabled: false },
    workDir: folder,
    mediaDir: folder,
    sessionSecret: 'synthetic-session-fixture',
    mediaSecret: 'synthetic-media-fixture',
    logRequests: false
  }
  await writeFile(join(folder, 'serverConfig.json'), JSON.stringify(config))
  const register = resolve('node_modules/sucrase/register')
  const env = { ...process.env, NODE_ENV: 'test' }
  const cli = async (file: string, args: string[] = []): Promise<void> => {
    // Demo output contains a short-lived fixture session; consume it without logging it.
    try {
      await execute(
        process.execPath,
        ['-r', register, ...args, resolve(file)],
        { cwd: folder, env }
      )
    } catch {
      throw new Error(`Development fixture failed: ${file}`)
    }
  }
  try {
    await cli('src/server/dev/demo.ts')
    const preload = join(folder, 'archive.cjs')
    await writeFile(
      preload,
      `require(${JSON.stringify(resolve('src/server/dev/importArchiveCameras.ts'))}).readArchive=()=>[]`
    )
    await execute(
      process.execPath,
      [
        '-r',
        register,
        '-r',
        preload,
        resolve('src/server/dev/makeSeasonFromVideos.ts'),
        '--team',
        'Demo Import Team',
        '--season',
        'Demo Imported Spring',
        '--year',
        '2027'
      ],
      { cwd: folder, env }
    )
    await h.db
      .transaction()
      .execute(async trx => await createScoringGame(trx, await userMinter(trx)))
    const seasons = await h.db
      .selectFrom('seasons')
      .select(['starts_on', 'ends_on'])
      .execute()
    expect(seasons.length).greaterThan(3)
    expect(
      seasons.every(s => s.starts_on != null && s.ends_on >= s.starts_on)
    ).equals(true)
    const child = spawn(
      process.execPath,
      ['-r', register, resolve('src/server/index.ts')],
      { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let logs = ''
    child.stdout.on('data', b => {
      logs += String(b)
    })
    child.stderr.on('data', b => {
      logs += String(b)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(timer)
          reject(new Error('Server startup timed out'))
        }, 15000)
        const timer = setInterval(() => {
          if (logs.includes('listening on')) {
            clearTimeout(timeout)
            clearInterval(timer)
            resolve()
          } else if (child.exitCode != null) {
            clearTimeout(timeout)
            clearInterval(timer)
            reject(new Error('Server startup failed'))
          }
        }, 25)
      })
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/me/umpire-leagues`,
        { headers: { authorization: `Bearer ${h.tokens.get(101)!}` } }
      )
      expect(response.status).equals(200)
      expect(await response.json()).deep.equals({ leagues: [] })
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode == null) await once(child, 'exit')
    }
  } finally {
    await h.close()
    await rm(folder, { recursive: true, force: true })
  }
})
