import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import { maestro, type MaestroHandle } from '../../e2e/rigs/refinementsMaestro'
import type { BaseProjection } from '../app/field/fieldTypes'
import { runnerTargets } from '../app/scoring/runnerDrag'

interface FixtureState {
  actions: Array<{ call?: string; reason?: string }>
  line: {
    offense: { second?: unknown }
    balls: number
    strikes: number
    outs: number
  }
}
interface FixtureLayout {
  projection: BaseProjection
  menu: { x: number; y: number }
}

/** Run this fixture process on the test server; the simulator connects to its URL. */
async function serve(output: string): Promise<void> {
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
  let latest: FixtureState | undefined
  let layout: FixtureLayout | undefined
  app.use(express.json())
  app.post('/state', (req, res) => {
    latest = req.body
    res.sendStatus(204)
  })
  app.get('/state', (_req, res) => {
    res.json(latest ?? null)
  })
  app.post('/layout', (req, res) => {
    layout = req.body
    res.sendStatus(204)
  })
  app.get('/layout', (_req, res) => {
    res.json(layout ?? null)
  })
  app.use(express.static(directory))
  const port = Number(process.env.SCORING_FIXTURE_PORT)
  assert(
    Number.isInteger(port) && port > 0,
    'Supply SCORING_FIXTURE_PORT on the test server'
  )
  app.listen(port, process.env.SCORING_FIXTURE_HOST ?? '127.0.0.1')
}

/** Repeated body drags after failed pickoffs on the real scoring screen. */
async function main(): Promise<void> {
  const output = process.env.SCORING_ARTIFACT_DIR
  assert(output != null, 'Supply a run artifact directory')
  if (process.argv.includes('--serve')) {
    await serve(output)
    return
  }
  const device = process.env.SCORING_DEVICE_UDID
  const origin = process.env.SCORING_FIXTURE_URL
  assert(
    device != null && origin != null,
    'Supply simulator and reachable pickoff fixture URL'
  )
  await mkdir(output, { recursive: true })
  let latest: FixtureState | null = null
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let m: MaestroHandle | undefined
  try {
    daemon = await maestro(process.env.MAESTRO_D ?? 'pickoff-reset-regression')
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: origin })
    const waitFor = async (check: () => boolean): Promise<void> => {
      const deadline = Date.now() + 12000
      for (;;) {
        latest = (await (
          await fetch(new URL('/state', origin))
        ).json()) as FixtureState | null
        if (check()) return
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
    const { projection, menu } = (await (
      await fetch(new URL('/layout', origin))
    ).json()) as FixtureLayout
    assert(projection.feet != null && projection.heads != null)
    interface Node {
      text?: string
      bounds?: { x: number; y: number; width: number; height: number }
      children?: Node[]
    }
    const flatten = (node: Node): Node[] => [
      node,
      ...(node.children ?? []).flatMap(flatten)
    ]
    const button = flatten(await m.hierarchy()).find(
      node => node.text === 'Open scoring menu'
    )?.bounds
    assert(button != null, 'Locate Safari’s scoring menu in device points')
    const offset = {
      x: button.x + button.width / 2 - menu.x,
      y: button.y + button.height / 2 - menu.y
    }
    const devicePoint = ({ x, y }: { x: number; y: number }): string =>
      `${Math.round(x + offset.x)},${Math.round(y + offset.y)}`
    const first = projection.feet[1]
    const runner = devicePoint({
      x: first.x,
      y: (first.y + projection.heads[1].y) / 2
    })
    const safePoint = (base: number): string => {
      const { safe } = runnerTargets(
        projection.bases[base],
        projection.width,
        projection.height,
        base
      )
      return devicePoint({
        x: safe.x + safe.width / 2,
        y: safe.y + safe.height / 2
      })
    }
    await writeFile(path.join(output, 'before.png'), await m.screenshot())
    await m.command('dragAndDrop', {
      from: { text: '^Visitor 01$', index: 0 },
      to: { point: safePoint(1) },
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
        from: { point: runner },
        to: { point: safePoint(1) },
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
      from: { point: runner },
      to: { point: safePoint(2) },
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
      })()
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
