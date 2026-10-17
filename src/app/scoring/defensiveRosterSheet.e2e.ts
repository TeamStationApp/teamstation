import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../field/cameraModel'
import { createPlayers } from '../field/fieldModel'

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(
        join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
      )
const { MaestroD } = requireClient('maestro-d')

async function main(): Promise<void> {
  const mode = required('ROSTER_PLATFORM')
  assert(['ios', 'chrome', 'landscape'].includes(mode))
  const native = mode === 'ios'
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const appId = native
    ? required('SCORING_APP_ID')
    : required('SCORING_TEST_URL')
  const m = await daemon.attach(
    native
      ? {
          device: required('SCORING_DEVICE_UDID'),
          platform: 'ios',
          appId,
          stepDelay: 400,
          artifacts: 'on-failure'
        }
      : {
          device: `defensive-roster-${mode}`,
          platform: 'web',
          appId,
          stepDelay: 400,
          artifacts: 'on-failure',
          extra: {
            browser: 'chrome',
            windowSize: mode === 'landscape' ? '844x390' : '390x844'
          }
        }
  )
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  await mkdir(artifacts, { recursive: true })
  const capture = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name + '.png'), await m.screenshot())
    await writeFile(
      join(artifacts, name + '.json'),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  const fieldTap = async (label: string): Promise<void> => {
    // Nameplate labels lie above the canvas and pass touches to the actual field.
    await m.evalBrowserScript({
      script: `const el=document.querySelector('[aria-label="${label}"]');const r=(el??document.querySelector('canvas')).getBoundingClientRect();return JSON.stringify({missing:el==null,x:r.x,y:r.y,width:r.width,height:r.height})`,
      output: 'point'
    })
    const point = JSON.parse((await m.vars()).point) as {
      missing: boolean
      x: number
      y: number
      width: number
      height: number
    }
    if (point.missing) {
      assert.equal(label, 'Clayton K')
      // The pitcher nameplate is hidden; project the actual player's body into the canvas.
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width: point.width,
        height: point.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const player = createPlayers().find(player => player.id === 'P')!
      const v = new Vector3(player.position.x, 5, player.position.z).project(
        camera
      )
      await m.tapOnPoint({
        x: point.x + ((v.x + 1) * point.width) / 2,
        y: point.y + ((1 - v.y) * point.height) / 2
      })
    } else
      await m.tapOnPoint({
        x: point.x + point.width / 2,
        y: point.y + point.height / 2
      })
  }
  const tap = async (label: string): Promise<void> => {
    if (!native && ['First Name', 'Last Name', 'Jersey Number'].includes(label))
      await fieldTap(label)
    else await m.tapOn({ text: `^${label}$`, timeout: 10000 })
  }
  try {
    if (native) {
      await m.stopApp({ appId })
      await m.launchApp({ appId })
    } else {
      await m.openBrowser({ url: appId })
      await m.assertVisible({
        text: 'Missing defensive positions',
        timeout: 30000
      })
      await fieldTap('Assign P')
    }
    await m.assertVisible({ text: '^Assign pitcher$', timeout: 30000 })
    await m.assertVisible({ text: '^Bench$' })
    await m.assertVisible({ text: '^Fielders$' })
    await m.assertVisible({ text: '^Create Player$' })
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (!native)
      await m.evalBrowserScript({
        script: `
      const sheet=document.querySelector('[data-testid="Scoring sheet"]');
      const r=sheet.getBoundingClientRect();
      if(Math.abs(r.height-innerHeight*2/3)>2)throw Error('Sheet height mismatch');
      const bench=document.querySelector('[data-testid="Defensive Bench"]');
      const fielders=document.querySelector('[data-testid="Defensive Fielders"]');
      if(!(bench.compareDocumentPosition(fielders)&4))throw Error('Group order');
      if(bench.querySelector('[data-testid^="Defensive position "]'))throw Error('Bench has badge');
      const cells=[...bench.querySelectorAll('[role="button"]')].map(e=>e.getBoundingClientRect());
      if(cells[0].y!==cells[1].y||cells[0].x>=cells[1].x)throw Error('Two columns');
      const footer=document.querySelector('[aria-label="Create Player"]').getBoundingClientRect();
      if(footer.bottom>innerHeight||footer.y<r.y)throw Error('Footer outside sheet');
      if(!fielders.textContent.includes('Mike T #27'))throw Error('Name jersey order');
      if(!bench.textContent.includes('Nolan A')||bench.textContent.includes('Nolan A #'))throw Error('Missing jersey');
      return 'layout passed';`
      })
    await capture(
      mode === 'landscape' ? 'chrome-landscape-after' : mode + '-roster-after'
    )
    if (mode === 'landscape') {
      console.log(
        'PASS Chrome landscape: two-thirds height, two columns, pinned footer'
      )
      return
    }
    await tap('Create Player')
    await m.assertVisible({ text: '^First Name$' })
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (native) await m.tapOn({ text: '^Cancel$', timeout: 10000 })
    else {
      await m.evalBrowserScript({
        script: `const r=[...document.querySelectorAll('[aria-label="Cancel"]')].at(-1).getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})`,
        output: 'point'
      })
      const point = JSON.parse((await m.vars()).point)
      await m.tapOnPoint({ x: point.x, y: point.y })
    }
    await m.assertVisible({ text: '^Assign pitcher$' })
    await tap('Create Player')
    await m.waitForAnimationToEnd({ timeout: 3000 })
    for (const [label, value] of [
      ['First Name', 'Clayton'],
      ['Last Name', 'Kershaw'],
      ['Jersey Number', '22']
    ]) {
      if (native) {
        await tap(label)
        await m.inputText({ text: value })
      } else
        await m.inputText({ text: value, css: `input[aria-label="${label}"]` })
    }
    if (native) await m.hideKeyboard()
    await tap('Create Player')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await m.assertNotVisible({ text: '^First Name$' })
    await m.assertVisible({ text: 'Assign P #22 Clayton K' })
    await capture(mode + '-player-created')
    await tap('Create Player')
    if (native) {
      await m.waitForAnimationToEnd({ timeout: 3000 })
      await tap('Throws')
      await m.hideKeyboard()
      await m.swipe({ start: '25%, 55%', end: '25%, 20%', duration: 400 })
    }
    await m.scrollUntilVisible({
      element: { text: '^Create Placeholder Player$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Create Placeholder Player')
    await m.assertVisible({
      text: '^Select number of players to create\\.$',
      timeout: 15000
    })
    // The initial quantity is one on every platform; no wheel-specific gestures needed.
    await tap('Create')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await m.scrollUntilVisible({
      element: { text: 'Assign P Hawks A' },
      direction: 'DOWN',
      timeout: 15000
    })
    await capture(mode + '-placeholders-created')
    await m.scrollUntilVisible({
      element: { text: 'Assign P #22 Clayton K' },
      direction: 'UP',
      timeout: 15000
    })
    await tap('Assign P #22 Clayton K')
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (native) await tap('Open pitcher')
    else await fieldTap('Clayton K')
    await m.assertVisible({ text: '^Assign pitcher$' })
    await m.scrollUntilVisible({
      element: { text: 'Assign P #27 Mike T' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Assign P #27 Mike T')
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (native) await tap('Open catcher')
    else await fieldTap('Assign C')
    await m.assertVisible({ text: '^Assign catcher$' })
    await m.assertVisible({ text: 'Assign C #27 Mike T' })
    await capture(mode + '-substitution')
    console.log(
      `PASS ${mode}: cancel, named creation, placeholders, bench assignment, substitution and vacated catcher`
    )
  } finally {
    await m.detach()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
