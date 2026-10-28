import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

/**
 * The ingest's entry file, run the way a service runs it: its own process,
 * with a `serverConfig.json` in the directory it starts in.
 */
const register = require.resolve('sucrase/register')
const entry = resolve('src/server/ingest/main.ts')

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

async function runMain(
  folder: string,
  config: Record<string, unknown>,
  args: string[] = []
): Promise<Run> {
  await writeFile(join(folder, 'serverConfig.json'), JSON.stringify(config))
  const child = spawn(process.execPath, ['-r', register, entry, ...args], {
    cwd: folder,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const code = await new Promise<number | null>(resolve => {
    child.on('exit', resolve)
  })
  return { code, stdout, stderr }
}

describe('the ingest entry', function () {
  this.timeout(60000)
  let folder = ''
  let workDir = ''

  before(async function () {
    folder = await mkdtemp(join(tmpdir(), 'tsIngestMain-'))
    workDir = join(folder, 'work')
    await mkdir(workDir)
  })

  after(async function () {
    await rm(folder, { recursive: true, force: true })
  })

  it('prints listenPort + 1000 as its only line, and writes nothing', async function () {
    const run = await runMain(
      folder,
      { listenPort: 9100, workDir, mediaDir: join(folder, 'media') },
      ['--print-health-port']
    )
    expect(run.code).equals(0)
    expect(run.stdout).equals('10100\n')
    expect(await readdir(workDir)).deep.equals([])
  })

  it('prints the configured health port', async function () {
    const run = await runMain(
      folder,
      { listenPort: 9100, workDir, live: { healthPort: 12345 } },
      ['--print-health-port']
    )
    expect(run.code).equals(0)
    expect(run.stdout).equals('12345\n')
  })

  it('exits 0 when live is switched off', async function () {
    const run = await runMain(folder, {
      listenPort: 9100,
      workDir,
      sessionSecret: 's'.repeat(32),
      live: { enabled: false }
    })
    expect(run.code).equals(0)
    expect(run.stdout).includes(
      'live ingest is switched off (live.enabled is false)'
    )
  })
})
