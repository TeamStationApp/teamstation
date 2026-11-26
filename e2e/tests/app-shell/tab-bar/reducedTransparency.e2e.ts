import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import { navTab, navTabSelected } from '../../../../src/test/navTab.e2e'
import { boxOf, flatten } from '../../../rigs/app/keyboardDock'
import {
  launchTabBarSimulator,
  openTabBar,
  requireSystemTabBar,
  withIosAppearance
} from '../../../rigs/app/tabBar'
import {
  assertNormalNavigation,
  assertOpaqueNavigation,
  navigationPaint
} from '../../../rigs/app/tabBarContrast'
import {
  controlBox,
  phoneTabSpec,
  windowBox
} from '../../../rigs/app/tabBarLayout'
import { DEVELOP_APP } from '../../../rigs/coach/coachApp'

/** Read the system switch before changing it, and restore that value on exit. */
async function openSwitch(
  device: any,
  ios: boolean
): Promise<{ id?: string; text: string } | { point: string }> {
  if (ios) {
    await device.launchApp({
      appId: 'com.apple.Preferences',
      stopApp: false,
      permissions: { all: 'unset' }
    })
    const target = { text: 'Reduce Transparency' }
    if (
      (await device.assertVisible({ ...target, timeout: 600 }).then(
        () => true,
        () => false
      )) !== true
    ) {
      for (const text of ['Accessibility', 'Display & Text Size']) {
        await device.scrollUntilVisible({
          element: { text },
          direction: 'DOWN',
          timeout: 10000
        })
        await device.tapOn({ text })
      }
      await device.scrollUntilVisible({
        element: target,
        direction: 'DOWN',
        timeout: 10000
      })
    }
    // Settings exposes a separate button for the label on recent iOS.
    // Tap the switch itself when the accessibility tree exposes its frame.
    const row = flatten(await device.hierarchy()).find(
      n => n.type?.endsWith('Switch') === true && n.text === target.text
    )
    const box = boxOf(
      row?.children?.find(n => n.type?.endsWith('Switch') === true)
    )
    if (box != null)
      return {
        point:
          Math.round(box.x + box.width / 2) +
          ',' +
          Math.round(box.y + box.height / 2)
      }
    return target
  }
  await device.launchApp({ appId: 'com.android.settings' })
  const target = { id: 'android:id/switch_widget', text: 'Outline text' }
  if (
    (await device.assertVisible({ ...target, timeout: 600 }).then(
      () => true,
      () => false
    )) !== true
  ) {
    await device.tapOn({ text: 'Search Settings' })
    await device.inputText({ text: 'Outline text' })
    await device.hideKeyboard()
    await device.assertVisible({ ...target, timeout: 10000 })
  }
  return target
}

async function switchState(device: any, ios: boolean): Promise<boolean> {
  const nodes = flatten(await device.hierarchy()) as Array<{
    type?: string
    id?: string
    text?: string
    value?: string
    checked?: boolean
    children?: Array<{ type?: string; text?: string }>
  }>
  const label = ios ? 'Reduce Transparency' : 'Outline text'
  const item = nodes.find(
    n =>
      n.type?.endsWith('Switch') === true &&
      (n.id === label || n.text === label)
  )
  const value =
    item?.checked ??
    item?.value ??
    item?.children?.find(child => child.type === 'Switch')?.text
  if (value === true || value === '1' || value === 'On') return true
  if (value === false || value === '0' || value === 'Off') return false
  throw new Error(
    'Could not read the original accessibility switch value for ' + label
  )
}

export default phoneTabSpec({
  id: 'app-shell/tab-bar/reduced-transparency',
  title:
    'The system and fallback bars paint the app theme with accessible inactive icons',
  covers: [
    'src/app/components/AppNavCapsule.tsx',
    'src/app/components/reducedTransparency.native.ts',
    'ios/TeamStation/TSTabBarComponentView.mm'
  ],
  scenarios: Object.fromEntries(
    (['system', 'capsule'] as const).map(mode => [
      mode,
      async ctx => {
        const ios = ctx.surface === 'ios-app'
        const handset = await openTabBar(
          ctx,
          'member',
          ios && mode === 'capsule' ? 'capsule' : undefined
        )
        const appId = process.env.TS_TAB_APP_ID ?? DEVELOP_APP
        // A cold launch defaults to Home. Keep a different selected tab
        // through both visits to Settings to catch an unintended relaunch.
        await navTab(handset, 'videos')
        const firstSwitch = await openSwitch(handset, ios)
        const original = await switchState(handset, ios)
        // Foreground the existing process: a relaunch can hide a lost preference event.
        const returnToApp = async (): Promise<void> => {
          if (!ios) {
            // Pop the system Settings activities to reveal the actual task
            // underneath. A new launcher intent can reset the root screen.
            for (let step = 0; step < 8; step++) {
              const appVisible: boolean = await handset
                .assertVisible({ id: 'tab-home', timeout: 500 })
                .then(
                  () => true,
                  () => false
                )
              if (appVisible) break
              await handset.pressKey({ key: 'BACK' })
            }
          } else if (mode === 'capsule') {
            // simctl activates this task simulator's existing application. WDA's
            // default permission reset can terminate the background process.
            await launchTabBarSimulator(ctx.device('device'), appId, 'capsule')
          } else
            await handset.launchApp({
              appId,
              stopApp: false,
              permissions: { all: 'unset' }
            })
          await navTabSelected(handset, 'videos')
          if (ios && mode === 'system') await requireSystemTabBar(handset)
          else await handset.assertVisible({ id: 'tab-bar-capsule' })
        }
        const capture = async (
          name: string
        ): Promise<ReturnType<typeof navigationPaint>> => {
          const frame = await windowBox(handset)
          const home = await controlBox(handset, 'tab-home')
          const videos = await controlBox(handset, 'tab-videos')
          const png = Buffer.from(await handset.screenshot())
          writeFileSync(ctx.artifact(name), png)
          return navigationPaint(png, frame, videos, home)
        }
        const measure = async (
          suffix: string,
          enable: typeof firstSwitch
        ): Promise<void> => {
          if (!(await switchState(handset, ios))) await handset.tapOn(enable)
          assert.equal(await switchState(handset, ios), true)
          await returnToApp()
          const opaque = await capture('opaque-navigation' + suffix + '.png')
          assertOpaqueNavigation(opaque, ios && mode === 'system')

          const disable = await openSwitch(handset, ios)
          await handset.tapOn(disable)
          assert.equal(await switchState(handset, ios), false)
          await returnToApp()
          const normal = await capture('restored-navigation' + suffix + '.png')
          assertNormalNavigation(normal, opaque)
        }
        try {
          if (ios)
            await withIosAppearance(ctx.device('device'), async set => {
              for (const appearance of ['light', 'dark'] as const) {
                await set(appearance)
                await measure('-' + appearance, await openSwitch(handset, ios))
              }
            })
          else await measure('', firstSwitch)
          await ctx.checkpoint(
            'opaque-and-restored-navigation',
            { expect: [{ id: 'tab-videos' }] },
            handset
          )
        } finally {
          const restore = await openSwitch(handset, ios)
          if ((await switchState(handset, ios)) !== original)
            await handset.tapOn(restore)
          assert.equal(await switchState(handset, ios), original)
          await handset.launchApp({
            appId,
            stopApp: false,
            permissions: { all: 'unset' }
          })
        }
      }
    ])
  )
})
