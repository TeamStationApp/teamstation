// Actual iPhone Safari acceptance. Start an owned maestro-d daemon and fixture
// preview first. Required: SCORING_DEVICE_UDID, MAESTRO_D, SCORING_TEST_URL,
// SCORING_ARTIFACT_DIR. Optional MAESTRO_D_CLIENT_ROOT resolves a packed client
// installed separately from the application. No simulator is booted or stopped.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const client = process.env.MAESTRO_D_CLIENT_ROOT
  ? createRequire(
      join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
    )
  : require
const { MaestroD } = client('maestro-d')
require('sucrase/register')
const required = key => {
  assert(process.env[key], `${key} is required`)
  return process.env[key]
}
const device = required('SCORING_DEVICE_UDID')
const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
const url = new URL(required('SCORING_TEST_URL'))
const daemon = await MaestroD.connect({
  name: required('MAESTRO_D'),
  spawn: false
})
const m = await daemon.attach({
  device,
  platform: 'ios',
  appId: 'com.apple.mobilesafari',
  artifacts: 'on-failure'
})
await mkdir(artifacts, { recursive: true })
let serial = 0
const report = []
const log = message => {
  report.push(message)
  console.log(message)
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)]
const nodes = async () => flatten(await m.hierarchy())
const tap = text =>
  m.tapOn({ text: `^${text}$`, enabled: true, timeout: 10000 })
const visible = text => m.assertVisible({ text, enabled: true, timeout: 15000 })
const absent = text => m.assertNotVisible({ text })
const shot = async label => {
  const stem = join(artifacts, `${String(++serial).padStart(2, '0')}-${label}`)
  await writeFile(`${stem}.png`, await m.screenshot())
  await writeFile(`${stem}.json`, JSON.stringify(await m.hierarchy(), null, 2))
  log(`Captured ${label}`)
}

try {
  await m.stopApp()
  await m.launchApp()
  await m.setOrientation('portrait')
  url.searchParams.set('scoringUiUpdates', String(Date.now()))
  await m.openLink({ link: url.href, browser: true })
  await visible('^Swing in Play$')
  if ((await nodes()).some(n => n.text === 'OK')) await tap('OK')
  await shot('new-controls')
  await tap('Swing in Play')
  await visible('^Home Run$')
  await tap('Dismiss outcomes')
  await tap('Bunt in Play')
  await absent('^Home Run$')
  await tap('Dismiss outcomes')
  await tap('Called Strike')
  await visible('^Called Strike$')
  await tap('Called Strike')
  await visible('^More$')
  await m.tapOn({ id: '^More$', enabled: true, timeout: 10000 })
  await absent('^Balk$')
  await absent('^This pitch$')
  await tap('Dropped Third Strike')
  await visible('^Safe$')
  await shot('first-base-decision')
  await tap('Safe')
  await visible('^Finish at-bat$')
  await visible('^Bottom Finish at-bat$')
  await shot('both-done-controls')
  await tap('Bottom Finish at-bat')
  await visible('Batter Player 2')
  await shot('next-batter')
  log(
    'PASS Safari control menus, hidden Balk and heading, automatic dropped-third first-base Safe decision and lower Done'
  )
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  await writeFile(join(artifacts, 'steps.txt'), report.join('\n') + '\n')
  daemon.close()
}
