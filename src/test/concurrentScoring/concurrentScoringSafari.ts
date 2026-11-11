import assert from 'node:assert/strict'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../app/field/cameraModel'
import { BASES } from '../../app/field/fieldModel'
import { initialHitTarget } from '../../app/field/trajectoryGuide'
import { ConcurrentScoringRig, type ScoringClient } from './concurrentScoring'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  type?: string
  text?: string
  id?: string
  enabled?: boolean
  bounds?: Bounds
  children?: Node[]
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** Two separately leased physical Safari sessions and an owned coach browser. */
export class ConcurrentScoringSafariRig extends ConcurrentScoringRig {
  protected override async openClient(
    role: string,
    index: number
  ): Promise<ScoringClient> {
    if (index === 2) return await super.openClient(role, index)
    const m = await this.ctx.attach(role, {
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      teamId: process.env.TS_IOS_TEAM_ID,
      waitForIdleTimeout: 500,
      stepDelay: 250
    })
    await m.setOrientation('portrait')
    // Clear previous test pages' live WebGL contexts before this fresh run.
    // Never restart Safari during a synchronization assertion.
    await m.stopApp({ appId: 'com.apple.mobilesafari' })
    await m.launchApp({ appId: 'com.apple.mobilesafari' })
    await m.openLink({
      link: `${this.ctx.stack.origin}/sign-in`,
      browser: true
    })
    const account = this.fixture.accounts[role]
    const until = Date.now() + 30000
    let signed = false
    do {
      const nodes = flatten(await m.hierarchy())
      signed = nodes.some(node => node.text?.startsWith('Account, ') === true)
      if (signed || nodes.some(node => node.text === 'Use a password instead'))
        break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < until)
    const openAccount = async (): Promise<void> => {
      await m.openLink({
        link: `${this.ctx.stack.origin}/account`,
        browser: true
      })
      await m.assertVisible({ text: '^Save name$', timeout: 30000 })
    }
    const isFixtureAccount = async (): Promise<boolean> =>
      flatten(await m.hierarchy()).some(node => node.text === account.email)
    if (signed) {
      await openAccount()
      signed = await isFixtureAccount()
      if (!signed) {
        // Repeated fixtures deliberately reuse labels, never identities.
        // Center the action clear of Safari and the app's bottom navigation.
        await m.scrollUntilVisible({
          element: { text: '^Sign out$' },
          direction: 'DOWN',
          centerElement: true,
          visibilityPercentage: 100
        })
        await m.tapOn({ text: '^Sign out$' })
        await m.openLink({
          link: `${this.ctx.stack.origin}/sign-in`,
          browser: true
        })
      }
    }
    if (!signed) {
      await m.tapOn({ text: '^Use a password instead$', timeout: 30000 })
      const focus = async (secure: boolean): Promise<void> => {
        const nodes = flatten(await m.hierarchy())
        const web = nodes.find(node => node.type === 'WebView')
        const field = flatten(web ?? { children: nodes }).find(
          node => node.type === (secure ? 'SecureTextField' : 'TextField')
        )?.bounds
        assert(field != null, 'The password form input is visible')
        await m.tapOnPoint({
          x: Math.round(field.x + field.width / 2),
          y: Math.round(field.y + field.height / 2)
        })
      }
      await focus(false)
      await m.inputText({ text: account.email })
      await m.hideKeyboard()
      await focus(true)
      await m.inputText({ text: account.password })
      await m.hideKeyboard()
      const signIn = flatten(await m.hierarchy())
        .filter(node => node.text === 'Sign in' && node.bounds != null)
        .at(-1)?.bounds
      // Some iOS keyboards submit the form when their Done key dismisses them.
      if (signIn != null)
        await m.tapOnPoint({
          x: Math.round(signIn.x + signIn.width / 2),
          y: Math.round(signIn.y + signIn.height / 2)
        })
      await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
    }
    await openAccount()
    assert(
      await isFixtureAccount(),
      'Safari must be signed in with the fixture email before opening its game'
    )
    await m.openLink({
      link: `${this.ctx.stack.origin}/games/${this.fixture.ids.game}/score`,
      browser: true
    })
    await m.assertVisible({ text: '^Swing in Play$', timeout: 30000 })
    return { m, page: null }
  }

  private async nodes(index: number): Promise<Node[]> {
    return flatten(await this.clients[index].m.hierarchy())
  }

  override async tap(index: number, text: string): Promise<void> {
    // Safari exposes the runner-specific accessibility name; Chromium's
    // text matcher also sees the shorter visible button caption.
    const label =
      index < 2 && (text === '^Out$' || text === '^Safe$')
        ? text.slice(0, -1) + '( .*)?$'
        : text
    await super.tap(index, label)
    if (index < 2 && text === '^Out$') {
      const putout = (await this.nodes(index)).find(node =>
        /^Putout by .*, catch 1$/.test(node.text ?? '')
      )
      if (putout != null) await super.tap(index, '^Putout by .*, catch 1$')
    }
  }

  override async text(index: number): Promise<string> {
    if (index === 2) return await super.text(index)
    return (await this.nodes(index))
      .map(node => node.text ?? node.id ?? '')
      .join('\n')
  }

  override async summary(index: number): Promise<string> {
    return (
      (await this.nodes(index)).find(
        node => node.text?.includes(' · Batter ') === true
      )?.text ?? ''
    )
  }

  override async lineup(index: number): Promise<string[]> {
    if (index === 2) return await super.lineup(index)
    return [
      ...new Set(
        (await this.nodes(index))
          .filter(node => node.text?.startsWith('Reorder ') === true)
          .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))
          .map(node => node.text ?? node.id ?? '')
          .filter(label => label.startsWith('Reorder '))
      )
    ]
  }

  override async pitch(
    index: number,
    label: string,
    completes = false
  ): Promise<void> {
    await this.clients[index].m.tapOn({
      text: `^${label}$`,
      enabled: true,
      timeout: 15000
    })
    if (!completes) await this.converge(index, label)
  }

  override async finish(index: number): Promise<void> {
    if (
      (await this.nodes(index)).some(
        node => node.text === 'Finish at-bat' || node.id === 'Finish at-bat'
      )
    )
      await this.tap(index, '^Finish at-bat$')
  }

  override async undo(index: number): Promise<void> {
    await this.tap(index, '^Undo .*')
  }

  override async undoAtBat(index: number): Promise<void> {
    await this.undo(index)
    for (let step = 0; step < 8; step++) {
      if (
        (await this.nodes(index)).some(
          node => node.text === 'Swing in Play' && node.enabled !== false
        )
      )
        return
      await this.undo(index)
    }
    throw new Error('Undo did not restore the pitch controls')
  }

  private async geometry(index: number): Promise<{
    field: Bounds
    project: (x: number, z: number, y?: number) => { x: number; y: number }
  }> {
    const field = (await this.nodes(index)).find(
      node => node.text?.startsWith('Baseball field.') === true
    )?.bounds
    assert(field != null, 'The visible Safari baseball field has bounds')
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      ...field,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    return {
      field,
      project: (x, z, y = 0.7) => {
        const p = new Vector3(x, y, z).project(camera)
        return {
          x: field.x + ((p.x + 1) * field.width) / 2,
          y: field.y + ((1 - p.y) * field.height) / 2
        }
      }
    }
  }

  private async drag(
    index: number,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): Promise<void> {
    const point = (p: { x: number; y: number }): string =>
      `${Math.round(p.x)},${Math.round(p.y)}`
    await this.clients[index].m.dragAndDrop({
      from: { point: point(from) },
      to: { point: point(to) },
      holdDuration: 200,
      duration: 800
    })
  }

  override async defender(
    index: number,
    jersey: number,
    base?: number
  ): Promise<void> {
    await this.clients[index].m.assertVisible({
      text: `^#${jersey}$`,
      timeout: 15000
    })
    const bounds = (await this.nodes(index)).find(
      node => node.text === `#${jersey}`
    )?.bounds
    assert(bounds != null, `Visible defender jersey ${jersey}`)
    const from = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2
    }
    if (base == null)
      await this.clients[index].m.tapOnPoint({
        x: Math.round(from.x),
        y: Math.round(from.y)
      })
    else {
      const g = await this.geometry(index)
      await this.drag(index, from, g.project(BASES[base].x, BASES[base].z, 0))
    }
  }

  override async trajectory(index: number): Promise<void> {
    await this.clients[index].m.assertVisible({
      text: '^Drag up and down for ball trajectory.*',
      timeout: 10000
    })
    const { field } = await this.geometry(index)
    const start = {
      x: field.x + field.width * 0.25,
      y: field.y + field.height * 0.6
    }
    await this.drag(index, start, { x: start.x, y: start.y - 30 })
  }

  override async hit(
    index: number,
    outcome: string,
    fielder?: number
  ): Promise<void> {
    await this.pitch(index, 'Swing in Play')
    await this.tap(index, `^${outcome}$`)
    if (outcome === 'Home Run') {
      const g = await this.geometry(index)
      const left = (await this.summary(index)).includes('left handed')
      const initial = initialHitTarget(left ? 'L' : 'R')
      const at = g.project(initial.x, initial.z)
      const to = g.project(0, -133, 8)
      const start = {
        x: g.field.x + g.field.width * 0.25,
        y: g.field.y + g.field.height * 0.64
      }
      await this.drag(index, start, {
        x: start.x + to.x - at.x,
        y: start.y + to.y - at.y
      })
    } else await this.defender(index, fielder ?? 8)
    await this.trajectory(index)
  }
}
