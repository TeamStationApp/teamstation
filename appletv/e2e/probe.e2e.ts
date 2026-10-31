import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import express from 'express'

async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
    TV_METRO_URL: metro,
    TV_PROBE_FILE: video
  } = process.env
  assert(
    device != null &&
      artifacts != null &&
      clientRoot != null &&
      metro != null &&
      video != null,
    'Set TV simulator, artifacts, client, Metro and synthetic video path'
  )
  const app = express()
  app.get('/clock.mp4', (_req, res) => {
    res.sendFile(path.resolve(video))
  })
  const server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const urls = [0, 1, 2, 3].map(i => `${origin}/clock.mp4?angle=${i}`)
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios' })
  async function clocks(): Promise<number[]> {
    const texts: string[] = []
    const walk = (node: any): void => {
      if (typeof node.text === 'string') texts.push(node.text)
      for (const child of node.children ?? []) walk(child)
    }
    walk(await tv.hierarchy())
    const text =
      texts.find(x => x.includes('Angle 1:') && x.includes('Angle 4:')) ?? ''
    return [...text.matchAll(/Angle \d: ([\d.]+)/g)].map(x => Number(x[1]))
  }
  async function advancing(previous: number[]): Promise<number[]> {
    const deadline = Date.now() + 15000
    do {
      const current = await clocks()
      if (
        current.length === 4 &&
        current.every((v, i) => v > (previous[i] ?? 0) + 1)
      )
        return current
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    throw new Error(
      'All four native player clocks must advance, including hidden angles'
    )
  }
  try {
    await tv.launchApp({
      appId: 'app.teamstation.tv',
      stopApp: true,
      environment: { TV_METRO_URL: metro, TV_PROBE_URLS: urls.join('|') }
    })
    await tv.assertVisible({ text: 'Playback verification', timeout: 30000 })
    await tv.tapOn({ text: 'Dismiss', optional: true, timeout: 1000 })
    const first = await advancing([0, 0, 0, 0])
    await tv.tapOn({ text: 'Hide angle 2' })
    const hidden = await advancing(first)
    await tv.tapOn({ text: 'Enlarge angle 1' })
    const enlarged = await advancing(hidden)
    await tv.tapOn({ text: 'Restore angle 2' })
    await tv.tapOn({ text: 'Collapse angle 1' })
    const restored = await advancing(enlarged)
    await writeFile(
      path.join(artifacts, 'tv-playback-probe.png'),
      await tv.screenshot()
    )
    console.log(
      'PASS: four native playback clocks advance through hide, enlarge, restore and collapse',
      JSON.stringify({ first, hidden, enlarged, restored })
    )
  } finally {
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await new Promise<void>((resolve, reject) =>
      server.close(error => {
        error != null ? reject(error) : resolve()
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
