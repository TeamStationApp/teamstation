import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import express from 'express'

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `Supply ${key}`)
  return value
}
async function main(): Promise<void> {
  const device = required('TS_SCORING_SIMULATOR_UDID')
  const directory = required('TS_DEFENSE_FIXTURE_DIR')
  const artifacts = required('TS_E2E_ARTIFACT_DIR')
  const booted = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  )
  assert(
    (Object.values(booted.devices).flat() as any[]).some(
      d => d.udid === device
    ),
    'Use an already running simulator'
  )
  const cases = (
    await readFile(join(artifacts, 'dictated-defense-integration.log'), 'utf8')
  )
    .split('\n')
    .filter(l => l.startsWith('{"said":'))
    .map(l => JSON.parse(l))
  assert.equal(cases.length, 2, 'Run the real interpreter integration first')
  const app = express()
  app.get('/cases', (_, res) => {
    res.json(cases)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const req = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )
  const { MaestroD } = req('maestro-d')
  const bin = required('MAESTRO_D_BIN')
  execFileSync(bin, ['ps'], { stdio: 'inherit' })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'scoring-defense-e2e',
    bin,
    idleTimeout: 0
  })
  const sim = await daemon.attach({
    device,
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure'
  })
  let recording: ReturnType<typeof spawn> | undefined
  try {
    await sim.openLink({ link: `http://127.0.0.1:${address.port}` })
    await sim.assertVisible({ text: '^Play 6-4-3$', timeout: 15000 })
    recording = spawn('xcrun', [
      'simctl',
      'io',
      device,
      'recordVideo',
      '--force',
      join(artifacts, 'defensive-throws.mp4')
    ])
    await new Promise(resolve => setTimeout(resolve, 1000))
    for (const label of ['6-4-3', '3-1', 'Pickoff']) {
      await sim.tapOn({ text: `^Play ${label}$` })
      const completed =
        label === 'Pickoff'
          ? 'Failed pickoff'
          : cases[label === '6-4-3' ? 0 : 1].said
      await sim.assertVisible({
        text: `${completed} — Complete`,
        timeout: 30000
      })
      await writeFile(
        join(artifacts, `defense-${label}.png`),
        await sim.screenshot()
      )
    }
    console.log(
      'PASS simulator rendered real-interpreter 6-4-3, 3-1 and failed pickoff through completion'
    )
  } finally {
    if (recording != null) {
      recording.kill('SIGINT')
      await new Promise(resolve => recording!.once('exit', resolve))
    }
    await sim.detach()
    server.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
