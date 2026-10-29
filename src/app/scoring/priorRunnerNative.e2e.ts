import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const { MaestroD } = require(process.env.MAESTRO_D_CLIENT_ROOT ?? 'maestro-d')
const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `Missing ${name}`)
  return value
}
async function main(): Promise<void> {
  const device = required('SCORING_DEVICE_UDID')
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId: 'app.teamstation.app',
    artifacts: 'on-failure'
  })
  await mkdir(artifacts, { recursive: true })
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text: `^${text}$`, timeout: 10000 })
  }
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, `${name}.png`), await m.screenshot())
  }
  // The current iOS driver caches portrait dimensions. W3C viewport coordinates
  // also support one uninterrupted path reversing across the halfway threshold.
  // Send through maestro-d's documented JS HTTP engine to its own device's WDA.
  const driverLog = await readFile(
    join(daemon.info.runDir, 'daemon.log'),
    'utf8'
  )
  const line = driverLog
    .split('\n')
    .filter((s: string) =>
      s.includes(`Starting WDA on device ${device} (port:`)
    )
    .at(-1)
  assert(
    line != null,
    'Cannot identify this device WDA endpoint in the owned daemon log'
  )
  const port = /\(port: (\d+)\)/.exec(line)?.[1]
  assert(port != null, 'Missing WDA port')
  const wda = `http://127.0.0.1:${port}`
  async function request(
    path: string,
    body?: unknown
  ): Promise<{ sessionId?: string; value: any }> {
    const script =
      body == null
        ? `http.get(${JSON.stringify(wda + path)})`
        : `http.post(${JSON.stringify(wda + path)}, {body:${JSON.stringify(body)}})`
    const result = await m.eval(script)
    assert.equal(result.status, 200, result.body)
    const parsed = JSON.parse(result.body)
    assert(parsed.value?.error == null, JSON.stringify(parsed))
    return parsed
  }
  const session = (await request('/status')).sessionId
  assert(session != null, 'WDA session is required')
  async function gesture(
    points: Array<{ x: number; y: number; duration?: number; pause?: number }>,
    hold = 500
  ): Promise<void> {
    const size = (await request(`/session/${session}/window/size`)).value
    const move = (
      p: { x: number; y: number },
      duration: number
    ): {
      type: string
      duration: number
      x: number
      y: number
      origin: string
    } => {
      assert(
        p.x >= 0 && p.x < size.width && p.y >= 0 && p.y < size.height,
        JSON.stringify({ p, size })
      )
      return {
        type: 'pointerMove',
        duration,
        x: Math.round(p.x),
        y: Math.round(p.y),
        origin: 'viewport'
      }
    }
    await request(`/session/${session}/actions`, {
      actions: [
        {
          type: 'pointer',
          id: 'scoring-finger',
          parameters: { pointerType: 'touch' },
          actions: [
            move(points[0], 0),
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: hold },
            ...points
              .slice(1)
              .flatMap(p => [
                move(p, p.duration ?? 850),
                { type: 'pause', duration: p.pause ?? 150 }
              ]),
            { type: 'pointerUp', button: 0 }
          ]
        }
      ]
    })
  }

  interface Node {
    text?: string
    children?: Node[]
  }
  interface Proof {
    open: boolean
    bases: Array<number | null>
    score: number
    count: { balls: number; strikes: number; outs: number }
    times: Array<string | null>
  }
  const flatten = (node: Node): Node[] => [
    node,
    ...(node.children ?? []).flatMap(flatten)
  ]
  const proof = async (): Promise<Proof> => {
    const node = flatten(await m.hierarchy()).find(
      node => node.text?.startsWith('Fixture state ') === true
    )
    assert(node?.text != null, 'Fixture state is accessible')
    return JSON.parse(node.text.slice('Fixture state '.length)) as Proof
  }
  const fixture = async (name: string): Promise<void> => {
    await tap(`Fixture ${name}`)
    await m.assertVisible({ id: 'field-nameplate', timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  const first = [
    { x: 196, y: 452 },
    { x: 287, y: 528 }
  ]
  const second = [
    { x: 106, y: 520 },
    { x: 196, y: 453 }
  ]
  console.log(
    '$ node -r sucrase/register src/app/scoring/priorRunnerNative.e2e.ts (one attached iPhone)'
  )
  try {
    for (const scenario of (
      process.env.SCENARIOS ?? 'first,second,pitched,home,timed'
    )
      .split(',')
      .filter(name => name.length > 0)) {
      await fixture(scenario)
      if (scenario === 'timed') {
        await tap('Swing in Play')
        await tap('Single')
        await tap('Juan S')
        await gesture([{ x: 196, y: 450 }])
        await new Promise(resolve => setTimeout(resolve, 15000))
      }
      const before = await proof()
      if (scenario === 'timed')
        assert.equal(
          before.open,
          false,
          'The real Done countdown closed the single'
        )
      if (scenario === 'first' || scenario === 'pitched') await gesture(first)
      if (scenario === 'second' || scenario === 'timed') await gesture(second)
      if (process.env.BASELINE === '1') {
        await shot(
          `${scenario === 'pitched' ? 'pitch-confirmation' : scenario + '-return'}-before`
        )
        continue
      }
      if (scenario === 'home')
        await gesture([
          { x: 159, y: 542 },
          { x: 106, y: 528 }
        ])
      if (scenario === 'pitched') {
        await m.assertVisible({
          text: 'Yes, send back runner',
          timeout: 5000
        })
        await shot('pitch-confirmation-after')
        assert.deepEqual(await proof(), before, 'Proposal is read-only')
        await tap('Cancel')
        assert.deepEqual(
          await proof(),
          before,
          'Cancel retains the full fixture state'
        )
        await gesture(first)
        await tap('Yes, send back runner')
      }
      const to =
        scenario === 'second' || scenario === 'timed'
          ? 2
          : scenario === 'home'
            ? 3
            : 1
      await shot(`${scenario}-return-after`)
      await m.assertVisible({
        text: `Runner did not advance on prior play. Sent back to ${['', '1st', '2nd', '3rd'][to]}.`,
        timeout: 3000
      })
      const after = await proof()
      assert.equal(after.bases[to - 1], 100)
      assert.deepEqual(after.count, before.count)
      assert.deepEqual(
        after.times,
        before.times,
        'Every current pitch retains its original time'
      )
      if (scenario === 'home') assert.equal(after.score, 0)
      console.log(
        `S2/S3/S4: ${scenario} return, current count and original times verified`
      )
      if (scenario === 'timed') {
        await tap('Reopen fixture')
        assert.deepEqual(
          await proof(),
          after,
          'The timed-play return survives reopening'
        )
        console.log(
          'Single entered through native controls, real Done timer and saved return verified'
        )
      }
      if (scenario === 'pitched') {
        await tap('Reopen fixture')
        await m.assertVisible({ id: 'field-nameplate', timeout: 15000 })
        assert.deepEqual(
          await proof(),
          after,
          'Reopen keeps the corrected game'
        )
        await m.tapOn({ text: 'Undo.*', timeout: 5000 })
        const undone = await proof()
        assert.equal(undone.bases[0], 100)
        assert.equal(undone.count.balls, 1)
        await tap('Ball')
        await new Promise(resolve => setTimeout(resolve, 2000))
        assert.equal((await proof()).count.balls, 2)
        console.log('S6: reopen, Undo and next pitch verified')
      }
    }
    if (process.env.BASELINE !== '1') {
      await fixture('occupied')
      const occupied = await proof()
      await gesture(first)
      assert.deepEqual(await proof(), occupied, 'Occupied retreat is inert')
      console.log('S5: occupied target rejected')
      await fixture('open')
      assert.equal((await proof()).open, true, 'Fixture is still an open play')
      await gesture(second)
      assert.equal((await proof()).bases[1], 100)
      await gesture([
        { x: 196, y: 452 },
        { x: 106, y: 528 },
        { x: 46, y: 491 }
      ])
      assert.equal((await proof()).bases[2], 100)
      console.log('S1: open return and re-advance remain immediate')
      await shot('open-return-forward-after')
    }
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
