import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { createPlayers } from '../../../../src/app/field/fieldModel'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import { scorePath } from '../../../rigs/scoring/phoneScorer'

/**
 * The defensive sheet over the web scoring screen, portrait and landscape,
 * on a game whose Hawks have nobody at P or LF (`defense-gaps`): the sheet
 * is two thirds of the window, Bench above Fielders in two columns, its
 * Create Player footer pinned inside it, fielders named with their jersey
 * and a bench player without one; then (portrait) Create Player cancels and
 * creates a named player, placeholders are made, a bench player is
 * assigned and substitutes, and the catcher he left is vacant.
 */

const PORTRAIT = { width: 390, height: 844 }
const LANDSCAPE = { width: 844, height: 390 }

async function sheet(
  ctx: HarnessContext,
  mode: 'chrome' | 'landscape'
): Promise<void> {
  const world = await ctx.fixture('defense-gaps')
  await clearSignInLimits(ctx)
  // The password form's signed-in check reads the phone layout's menu, so
  // the browser signs in in portrait and then turns.
  const session = await ctx.browser(PORTRAIT)
  const { m } = session
  await m.openLink({ link: `${ctx.stack.origin}/` })
  await ctx.signIn('scorer', m)
  if (mode === 'landscape') await session.resize(LANDSCAPE)
  const capture = async (name: string): Promise<void> => {
    await m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
    writeFileSync(
      ctx.artifact(`${name}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  const fieldTap = async (label: string): Promise<void> => {
    // Nameplate labels lie above the canvas and pass touches to the field.
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
      expect(label).to.equal('Clayton K')
      // The pitcher's nameplate is hidden: his body, projected into the canvas.
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
      const player = createPlayers().find(each => each.id === 'P')!
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
    if (['First Name', 'Last Name', 'Jersey Number'].includes(label))
      await fieldTap(label)
    else await m.tapOn({ text: `^${label}$`, timeout: 10000 })
  }
  await m.openLink({ link: `${ctx.stack.origin}${scorePath(world.ids.game)}` })
  await m.assertVisible({ text: 'Assign a pitcher', timeout: 30000 })
  await fieldTap('Assign P')
  await m.assertVisible({ text: '^Assign pitcher$', timeout: 30000 })
  await m.assertVisible({ text: '^Bench$' })
  await m.assertVisible({ text: '^Fielders$' })
  await m.assertVisible({ text: '^Create Player$' })
  await m.waitForAnimationToEnd({ timeout: 3000 })
  // Read in the page: throws, failing the step, when the layout is wrong.
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
      if(!/Mike T\\w* #27/.test(fielders.textContent))throw Error('Name jersey order');
      if(!/Nolan A/.test(bench.textContent)||/Nolan A\\w* #/.test(bench.textContent))throw Error('Missing jersey');
      return 'layout passed';`
  })
  await capture(
    mode === 'landscape' ? 'chrome-landscape-after' : 'chrome-roster-after'
  )
  if (mode === 'landscape') return

  await tap('Create Player')
  await m.assertVisible({ text: '^First Name$' })
  await m.waitForAnimationToEnd({ timeout: 3000 })
  await m.evalBrowserScript({
    script: `const r=[...document.querySelectorAll('[aria-label="Cancel"]')].at(-1).getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})`,
    output: 'point'
  })
  const cancel = JSON.parse((await m.vars()).point) as { x: number; y: number }
  await m.tapOnPoint({ x: cancel.x, y: cancel.y })
  await m.assertVisible({ text: '^Assign pitcher$' })
  await tap('Create Player')
  await m.waitForAnimationToEnd({ timeout: 3000 })
  for (const [label, value] of [
    ['First Name', 'Clayton'],
    ['Last Name', 'Kershaw'],
    ['Jersey Number', '22']
  ])
    await m.inputText({ text: value, css: `input[aria-label="${label}"]` })
  await tap('Create Player')
  await m.assertVisible({ text: '^Assign pitcher$' })
  await m.assertNotVisible({ text: '^First Name$' })
  await m.assertVisible({ text: 'Assign P #22 Clayton K' })
  await capture('chrome-player-created')
  await tap('Create Player')
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
  // The initial quantity is one on every platform.
  await tap('Create')
  await m.assertVisible({ text: '^Assign pitcher$' })
  await m.scrollUntilVisible({
    element: { text: 'Assign P Hawks A' },
    direction: 'DOWN',
    timeout: 15000
  })
  await capture('chrome-placeholders-created')
  await m.scrollUntilVisible({
    element: { text: 'Assign P #22 Clayton K' },
    direction: 'UP',
    timeout: 15000
  })
  await tap('Assign P #22 Clayton K')
  await m.waitForAnimationToEnd({ timeout: 3000 })
  await fieldTap('Clayton K')
  await m.assertVisible({ text: '^Assign pitcher$' })
  // A roster player is named in full when the signed-in scorer may read
  // him in full and short otherwise; Clayton, made here, is always short.
  await m.scrollUntilVisible({
    element: { text: 'Assign P #27 Mike T\\w*' },
    direction: 'DOWN',
    timeout: 15000
  })
  await tap('Assign P #27 Mike T\\w*')
  await m.waitForAnimationToEnd({ timeout: 3000 })
  await fieldTap('Assign C')
  await m.assertVisible({ text: '^Assign catcher$' })
  await m.assertVisible({ text: 'Assign C #27 Mike T\\w*' })
  await capture('chrome-substitution')
}

export default defineHarness({
  id: 'scoring/defensive-sheet/sheet-layout',
  title: 'The defensive sheet lays out, creates and substitutes on the web',
  kind: 'e2e',
  covers: [
    'src/app/scoring/DefensiveRosterSheet.tsx',
    'src/app/scoring/currentSetup.ts',
    'src/app/scoring/placeholderPlayers.ts',
    'src/app/scoring/playerDraft.ts'
  ],
  stack: 'isolated',
  fixtures: ['defense-gaps'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // The scoring field draws in 3D: the Mac's browser, with its GPU.
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    portrait: async ctx => {
      await sheet(ctx, 'chrome')
    },
    landscape: async ctx => {
      await sheet(ctx, 'landscape')
    }
  }
})
