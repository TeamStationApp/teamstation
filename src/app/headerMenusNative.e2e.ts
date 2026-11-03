import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { maestro, type MaestroHandle } from '../test/refinementsMaestro.e2e'
import type { TessNativeManifest } from '../test/tessNativeFixture.e2e'

/**
 * The header's two menus on a phone, driven by maestro-d against the fixture
 * `tessNativeFixture.e2e.ts` runs (its manifest is `TS_TESS_NATIVE_MANIFEST`),
 * on a build whose `TS_API_BASE_URL` names that fixture.
 *
 *   TS_HEADER_LAYOUT=iphone TS_HEADER_IOS_DEVICE=<udid>
 *   TS_HEADER_LAYOUT=android TS_HEADER_ANDROID_DEVICE=<serial>
 *   TS_TESS_NATIVE_MANIFEST=<manifest> TS_ARTIFACTS_DIR=<dir>
 *   MAESTRO_D=<daemon> TS_MAESTRO_D_CLIENT=<client> MAESTRO_D_BIN=<bin>
 *   node -r sucrase/register src/app/headerMenusNative.e2e.ts
 *
 * `TS_HEADER_BEFORE=1` only takes the header's screenshot, for the build this
 * work started from. Device ids come from the environment and are never
 * written down. The sign-in code comes from the fixture's control endpoint
 * and is never printed.
 */

interface Node {
  text?: string
  id?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

const PICTURE = 'Account, .*'
const MARK = 'TeamStation menu'

const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

async function main(): Promise<void> {
  const android = process.env.TS_HEADER_LAYOUT === 'android'
  const before = process.env.TS_HEADER_BEFORE === '1'
  const prefix = android ? 'android' : 'ios'
  const out = resolve(process.env.TS_ARTIFACTS_DIR ?? 'artifacts/headerMenus')
  await mkdir(out, { recursive: true })
  const manifestPath = process.env.TS_TESS_NATIVE_MANIFEST
  if (manifestPath == null) throw new Error('Supply TS_TESS_NATIVE_MANIFEST')
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8')
  ) as TessNativeManifest
  const device = android
    ? process.env.TS_HEADER_ANDROID_DEVICE
    : process.env.TS_HEADER_IOS_DEVICE
  if (device == null || device === '')
    throw new Error('Supply TS_HEADER_IOS_DEVICE or TS_HEADER_ANDROID_DEVICE')
  const daemon = await maestro(process.env.MAESTRO_D ?? `header-${prefix}`)
  const m: MaestroHandle = await daemon.attach({
    device,
    platform: android ? 'android' : 'ios',
    appId: 'app.teamstation.app',
    artifacts: 'on-failure',
    driverStartTimeout: 180
  })
  const native = m as unknown as { back: () => Promise<unknown> }
  const show = async (text: string, timeout = 20000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const hidden = async (text: string): Promise<void> => {
    await m.assertNotVisible({ text, timeout: 15000 })
  }
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 20000 })
    await m.waitForAnimationToEnd()
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd()
    await writeFile(join(out, name), await m.screenshot())
    console.log('Saved', name)
  }
  const nodes = async (): Promise<Node[]> =>
    flatten((await m.hierarchy()) as Node)
  const boundsOf = async (
    match: (node: Node) => boolean
  ): Promise<NonNullable<Node['bounds']>> => {
    const node = (await nodes()).find(n => n.bounds != null && match(n))
    if (node?.bounds == null) throw new Error('Nothing on screen matched')
    return node.bounds
  }
  const isPicture = (node: Node): boolean =>
    (node.text ?? '').startsWith('Account, ')
  const isRow = (label: string) => (node: Node) =>
    node.text === label || node.id === label

  const signIn = async (): Promise<void> => {
    await m.launchApp({})
    try {
      await show('E-mail address', 30000)
    } catch {
      return
    }
    await tap('E-mail address')
    await m.inputText({ text: manifest.email })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Send me a sign-in code', optional: true })
    await show('.*six-digit code.*', 30000)
    let code: string | null = null
    for (let waited = 0; code == null && waited < 15000; waited += 1000) {
      const answer = await fetch(
        `${manifest.control}/code?email=${encodeURIComponent(manifest.email)}`
      )
      code = ((await answer.json()) as { code: string | null }).code
      if (code == null) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (code == null) throw new Error('No sign-in code was sent')
    await tap('Sign-in code')
    await m.inputText({ text: code })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Sign in', optional: true })
  }

  try {
    await signIn()
    await show(PICTURE, 60000)
    await capture(`${prefix}-header-${before ? 'before' : 'after'}.png`)
    if (before) {
      console.log('Header captured before the menus')
      return
    }

    // The picture's menu, right edge on the picture.
    await show(MARK)
    expect((await nodes()).filter(isRow('Notifications'))).deep.equals([])
    // Measured first: an open menu hides the app from the accessibility tree.
    const picture = await boundsOf(isPicture)
    await tap(PICTURE)
    await show('^Account$')
    await show('Notifications')
    await hidden('About TeamStation')
    const row = await boundsOf(isRow('Notifications'))
    // Bounds are in the driver's units, so this allows for the panel's border.
    expect(Math.abs(row.x + row.width - (picture.x + picture.width))).lessThan(
      8
    )
    expect(row.y).greaterThanOrEqual(picture.y)
    await capture(`${prefix}-user-menu.png`)

    // An outside tap closes the picture's menu, and About opens from the mark's.
    await m.tapOn({ point: '50%,85%' })
    await hidden('Notifications')
    await tap(MARK)
    await tap('About TeamStation')
    await show('Commit')
    await show('^[0-9a-f]{6}$')
    await show('Built')
    // In the device's own zone, which names itself, rather than as stored.
    await show('.*20[0-9]{2}.*[AP]M.*')
    await show(new URL(manifest.origin).origin)
    await tap('Close build information')
    console.log('Picture menu: rows and outside tap; About from the mark')

    // The mark's menu, and Tess from it.
    // The mark's left edge, and the panel's, within the panel's border.
    const markBounds = await boundsOf(isRow(MARK))
    await tap(MARK)
    await show('About TeamStation')
    await show('Ask Tess')
    const askTess = await boundsOf(isRow('Ask Tess'))
    expect(Math.abs(askTess.x - markBounds.x)).lessThan(8)
    // Its subtext is the row's accessibility hint here, so the screenshot shows it.
    await capture(`${prefix}-teamstation-menu.png`)
    await tap('Ask Tess')
    await m.tapOn({ text: 'Allow', optional: true, timeout: 5000 })
    await show('Close Tess')
    await tap('Close Tess')
    await hidden('Close Tess')
    console.log('Mark menu: Ask Tess opened her, and Close Tess closed her')

    // A pushed screen: no mark, and the picture's menu still works. On
    // Android, Back closes that menu and leaves the screen where it is.
    await tap(PICTURE)
    // Exactly, because the driver matches by contains and the picture's label
    // begins with the same word.
    await tap('^Account$')
    await show('You can always sign in.*', 30000)
    await hidden(MARK)
    await tap(PICTURE)
    await show('Notifications')
    if (android) {
      await native.back()
      await hidden('Notifications')
      await show('You can always sign in.*')
      await capture('android-menu-back.png')
      console.log('Android Back closed the menu and left Account in place')
    }
    console.log('Header menu native scenarios passed', prefix)
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
