import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import { makeDatabase } from '../db/database'
import { asServerConfig } from '../serverConfig'
import { ingestQuietMain, publishingCount } from './ingestQuiet'

/**
 * What a restart of the ingest asks first: is anybody publishing?
 */
const live = asServerConfig({}).live
const SECRET = 's'.repeat(32)

describe('whether the ingest is quiet', function () {
  this.timeout(60000)
  let fixture: LiveFixture | undefined
  let folder = ''

  before(async function () {
    fixture = await liveFixture('ingestquiet')
    if (fixture == null) this.skip()
    folder = await mkdtemp(join(tmpdir(), 'tsIngestQuiet-'))
  })

  after(async function () {
    await fixture?.drop()
    if (folder !== '') await rm(folder, { recursive: true, force: true })
  })

  async function main(databaseUrl: string): Promise<[number, string[]]> {
    const lines: string[] = []
    const code = await ingestQuietMain({
      databaseUrl,
      makeDatabase,
      print: line => lines.push(line)
    })
    return [code, lines]
  }

  async function program(): Promise<number | null> {
    await writeFile(
      join(folder, 'serverConfig.json'),
      JSON.stringify({ databaseUrl: fixture!.url })
    )
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        resolve('src/server/live/ingestQuiet.ts')
      ],
      { cwd: folder, stdio: 'ignore' }
    )
    return await new Promise(resolve => child.on('exit', resolve))
  }

  it('is quiet with nothing publishing', async function () {
    await fixture!.addStream(live, SECRET, 'idle')
    expect(await publishingCount(fixture!.db)).equals(0)
    expect(await main(fixture!.url)).deep.equals([
      0,
      ['ingest quiet: 0 publishing']
    ])
    expect(await program()).equals(0)
  })

  it('is busy while a stream is publishing', async function () {
    const stream = await fixture!.addStream(live, SECRET, 'publishing')
    expect(await publishingCount(fixture!.db)).equals(1)
    expect(await main(fixture!.url)).deep.equals([
      1,
      ['ingest busy: 1 publishing']
    ])
    expect(await program()).equals(1)
    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'idle' })
      .where('id', '=', stream.id)
      .execute()
    expect(await program()).equals(0)
  })

  it('answers 2, never busy, when its configuration will not load', async function () {
    await writeFile(
      join(folder, 'serverConfig.json'),
      JSON.stringify({ listenPort: 'not a port' })
    )
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        resolve('src/server/live/ingestQuiet.ts')
      ],
      { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let out = ''
    child.stdout.on('data', chunk => {
      out += String(chunk)
    })
    expect(await new Promise(resolve => child.on('exit', resolve))).equals(2)
    expect(out).matches(/^ingest unknown: /)
  })

  it('answers 2, never quiet, when the database cannot be read', async function () {
    const [code, lines] = await main('postgres://localhost:1/nowhere')
    expect(code).equals(2)
    expect(lines[0]).matches(/^ingest unknown: /)
  })
})
