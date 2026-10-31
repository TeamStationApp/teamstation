import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import { maestro, type MaestroHandle } from '../../e2e/rigs/refinementsMaestro'

/** Repeated body drags after failed pickoffs on the real scoring screen. */
async function main(): Promise<void> {
  const device = process.env.SCORING_DEVICE_UDID
  const output = process.env.SCORING_ARTIFACT_DIR
  assert(
    device != null && output != null,
    'Supply simulator and artifact directory'
  )
  const booted = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  ) as { devices: Record<string, Array<{ udid: string }>> }
  assert(
    Object.values(booted.devices)
      .flat()
      .some(simulator => simulator.udid === device),
    'Use an already-running iOS simulator'
  )
  const directory = path.join(output, 'fixture')
  await mkdir(directory, { recursive: true })
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  await build({
    ...webSettings,
    entryPoints: ['src/test/pickoffReset.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"',
      'process.env.TS_SENTRY_DSN': '""'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
    recursive: true
  })
  const html = (await readFile('src/app/web/index.html', 'utf8')).replace(
    '</head>',
    '<style>body{overflow:hidden}#root{display:block}</style></head>'
  )
  await writeFile(path.join(directory, 'index.html'), html)
  const app = express()
  let latest:
    | {
        actions: Array<{ reason?: string }>
        line: {
          offense: { second?: unknown }
          balls: number
          strikes: number
          outs: number
        }
      }
    | undefined
  app.use(express.json())
  app.post('/state', (req, res) => {
    latest = req.body
    res.sendStatus(204)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let m: MaestroHandle | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    assert(address != null && typeof address !== 'string')
    daemon = await maestro('pickoff-reset-regression')
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: `http://127.0.0.1:${address.port}` })
    const waitFor = async (check: () => boolean): Promise<void> => {
      const deadline = Date.now() + 12000
      while (!check()) {
        assert(Date.now() < deadline, 'Scoring did not accept the runner drag')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await m.assertVisible({ text: '^Ball$', timeout: 30000 })
    for (let i = 0; i < 4; i++) {
      await m.tapOn({ text: '^Ball$' })
      await waitFor(
        () =>
          latest?.actions.filter(a => 'call' in a && a.call === 'B').length ===
          i + 1
      )
      await m.waitForAnimationToEnd()
    }
    await m.assertVisible({ text: '^Visitor 01$', timeout: 15000 })
    await writeFile(path.join(output, 'before.png'), await m.screenshot())
    await m.command('dragAndDrop', {
      from: { text: '^Visitor 01$', index: 0 },
      to: { point: '88%,49%' },
      holdDuration: 500,
      duration: 1800
    })
    await waitFor(
      () =>
        latest?.actions.filter(a => a.reason === 'Safe from Pickoff').length ===
        1
    )
    await new Promise(resolve => setTimeout(resolve, 2500))
    await writeFile(
      path.join(output, 'after-pickoff.png'),
      await m.screenshot()
    )
    const count = {
      balls: latest!.line.balls,
      strikes: latest!.line.strikes,
      outs: latest!.line.outs
    }
    // Grab the athlete's body, not its nameplate: the overlapping defender
    // intercepted precisely this touch before the reset fix.
    for (let attempt = 2; attempt <= 3; attempt++) {
      await m.command('dragAndDrop', {
        from: { point: '74%,54.8%' },
        to: { point: '88%,49%' },
        holdDuration: 500,
        duration: 1800
      })
      await waitFor(
        () =>
          latest?.actions.filter(a => a.reason === 'Safe from Pickoff')
            .length === attempt
      )
      await new Promise(resolve => setTimeout(resolve, 2500))
    }
    assert.deepEqual(
      {
        balls: latest!.line.balls,
        strikes: latest!.line.strikes,
        outs: latest!.line.outs
      },
      count
    )
    await m.command('dragAndDrop', {
      from: { point: '74%,54.8%' },
      to: { point: '39%,44.5%' },
      holdDuration: 500,
      duration: 1800
    })
    await m.assertVisible({ text: '^Steal$', timeout: 3000 })
    await m.tapOn({ text: '^Steal$' })
    await waitFor(() => latest?.line.offense.second != null)
    await m.waitForAnimationToEnd()
    await writeFile(
      path.join(output, 'after-advance.png'),
      await m.screenshot()
    )
    console.log(
      'PASS simulator Safari: repeated body drags record failed pickoffs and advance the runner without Undo or another pitch'
    )
  } finally {
    server.closeAllConnections()
    const cleanup = await Promise.allSettled([
      writeFile(
        path.join(output, 'scoring-state.json'),
        JSON.stringify(latest ?? null, null, 2)
      ),
      (async () => {
        try {
          await m?.detach()
        } finally {
          await daemon?.shutdown()
        }
      })(),
      new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    ])
    const failures = cleanup.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      console.error(
        new AggregateError(
          failures.map(result => result.reason),
          'Pickoff test cleanup failed'
        )
      )
      process.exitCode = 1
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
