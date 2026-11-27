import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  aboveKeyboard,
  appOf,
  type Box,
  boxOf,
  flatten,
  type Node,
  platformOf,
  prove,
  typeKeys
} from '../../../rigs/app/keyboardDock'
import { pointAtStack } from '../../../rigs/app/pointAtStack'

/**
 * Add Player on a phone or tablet draws Search's own field, docked at the
 * bottom: focused, it rides up with the keyboard while the scene's header
 * stays where it was, and Add to Roster's form keeps its jersey field and
 * its button above the keyboard. Signs in as the `search` world's coach,
 * who may add players to the world's Demo Hawks, opens that team from Home
 * and then its settings, and clears the app's state before and after,
 * leaving the phone signed out; a clear forgets the stack, so the app is
 * pointed back at it after. Adds nobody.
 */
export default defineHarness({
  id: 'people/add-existing/add-player-device',
  title:
    'Add Player’s field rides the keyboard on a phone while its header stays put, and Add to Roster stays above it',
  kind: 'e2e',
  covers: [
    'src/app/screens/AddPlayerScene.tsx',
    'src/app/screens/KeyboardForm.native.tsx',
    'src/app/screens/SearchFieldDock.tsx',
    'src/app/components/SearchField.tsx',
    'src/app/components/keyboardControllerOwner.native.ts'
  ],
  stack: 'isolated',
  fixtures: ['search'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'allowed' }]
    },
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone'], simulator: 'allowed' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    keyboard: async ctx => {
      const world = await ctx.fixture('search')
      const account = world.accounts.coach
      const teamName = `Demo Hawks ${world.nonce}`
      const ios = platformOf(ctx) === 'ios'
      const appId = appOf(ctx)
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId
      })
      try {
        await signIn(device, ios, account, appId, ctx.stack.origin)
        await prove(ctx, device, `${platformOf(ctx)}-signed-in.png`)
        // Home lists the account's teams: the team, then its settings.
        await tapRow(device, teamName)
        await device.tapOn({ text: 'Manage', timeout: 15000 })
        await device.assertVisible({
          text: 'Player Name Privacy',
          timeout: 30000
        })
        await prove(ctx, device, `${platformOf(ctx)}-team-settings.png`)
        await tapRow(device, 'Add Player')
        await new Promise(resolve => setTimeout(resolve, 2000))
        await prove(ctx, device, `${platformOf(ctx)}-add-player.png`)
        await device.assertVisible({
          id: 'Player search field',
          timeout: 15000
        })
        await device.assertVisible({ id: 'search-dock', timeout: 5000 })

        const rest = await boxes(device)
        await device.tapOn({ id: 'search-field-input' })
        await typeKeys(device, ios, 'A')
        await new Promise(resolve => setTimeout(resolve, 1500))
        const raised = await boxes(device)
        const above = await aboveKeyboard(device, raised.field)
        await prove(ctx, device, `${platformOf(ctx)}-add-player-keyboard.png`)
        await ctx.checkpoint('field-rides-keyboard', {
          expect: [{ id: 'Player search field' }],
          readBack: async () => {
            // The scene stays put: its Cancel, top right, has not moved.
            expect(raised.cancel.y, 'the header stays where it was').closeTo(
              rest.cancel.y,
              rest.cancel.height / 4
            )
            // The field rose well clear of its rest, by a keyboard's height.
            expect(raised.field.y, 'the field rose with the keyboard').lessThan(
              rest.field.y - 2 * rest.field.height
            )
            if (above != null) {
              expect(above.above, 'the field sits above the keyboard').equals(
                true
              )
              expect(
                above.keyboard.y - (raised.field.y + raised.field.height),
                'just above it: no more than its own height between'
              ).lessThanOrEqual(raised.field.height)
            } else
              expect(
                raised.field.y + raised.field.height,
                'above where a keyboard reaches'
              ).lessThan(raised.screen * 0.65)
          }
        })

        // Add to Roster: its jersey field and its button above the keyboard.
        await device.tapOn({ text: 'Choose .*', index: 0, timeout: 15000 })
        await device.assertVisible({ text: 'Add to Roster', timeout: 15000 })
        await device.tapOn({ text: 'Jersey number' })
        await typeKeys(device, ios, '9')
        await new Promise(resolve => setTimeout(resolve, 1500))
        const nodes = flatten((await device.hierarchy()) as Node)
        const screen = screenHeight(nodes)
        // An iPad held sideways reports its keyboard's frame unrotated:
        // that says nothing about where it covers.
        const reported = boxOf(nodes.find(node => node.type === 'Keyboard'))
        const keys =
          reported != null && reported.width >= reported.height
            ? reported
            : undefined
        const reach = keys?.y ?? screen * keyboardReach(nodes)
        // The jersey field: by what it now holds on Android, by its label on
        // iOS, whose text field reports no value. The keyboard's own 9 key
        // is no field.
        const jersey = nodes
          .filter(
            node =>
              (node.text === '9' && node.type !== 'Key') ||
              (node.type === 'TextField' &&
                (node.accessibilityText ?? node.text) === 'Jersey number')
          )
          .map(boxOf)
          .filter((box): box is Box => box != null && box.y < screen)
          .sort((a, b) => a.y - b.y)[0]
        // The form's scroll view, the smallest holding the jersey field:
        // ending above the keyboard, all of it, Add to Roster too, scrolls
        // into view there. A swipe to show the button is no proof on an
        // iPad, where it lands on the positions or the field.
        const form =
          jersey == null
            ? undefined
            : nodes
                .filter(node => (node.type ?? '').includes('ScrollView'))
                .map(boxOf)
                .filter(
                  (box): box is Box =>
                    box != null &&
                    box.y <= jersey.y &&
                    box.y + box.height >= jersey.y + jersey.height
                )
                .sort((a, b) => a.height - b.height)[0]
        await prove(
          ctx,
          device,
          `${platformOf(ctx)}-add-to-roster-keyboard.png`
        )
        await ctx.checkpoint('form-above-keyboard', {
          expect: [{ text: 'Add to Roster' }],
          readBack: async () => {
            expect(jersey, 'the jersey field is on screen').not.equals(
              undefined
            )
            expect(form, 'the form scrolls').not.equals(undefined)
            if (jersey == null || form == null) return
            expect(
              jersey.y + jersey.height,
              `the jersey field (${JSON.stringify(jersey)}) above the keyboard (${reach})`
            ).lessThanOrEqual(reach)
            expect(
              form.y + form.height,
              `the form (${JSON.stringify(form)}) ends above the keyboard (${reach})`
            ).lessThanOrEqual(reach + 1)
          }
        })
        await device.tapOn({ text: 'Cancel' })
      } finally {
        // Signed out again, as the other phone scenarios expect.
        await device.launchApp({ appId, stopApp: true, clearState: true })
      }
    }
  }
})

/** Signs in with a password from a cleared app, pointed back at the stack. */
async function signIn(
  device: any,
  ios: boolean,
  account: { email: string; password: string },
  appId: string,
  origin: string
): Promise<void> {
  await device.launchApp({ appId, stopApp: true, clearState: true })
  await pointAtStack(device, origin, appId)
  // The password form, waited for: a launch can still be settling, and a
  // password typed into the e-mail field would ask for a code instead.
  // The swap is done when its link reads the other way: iOS matches text
  // by what it contains, so "Password" alone would find the link itself.
  for (let tries = 0; ; ++tries) {
    await device.tapOn({ text: 'Use a password instead', timeout: 30000 })
    try {
      await device.assertVisible({ text: 'Use a sign-in code', timeout: 10000 })
      break
    } catch (error) {
      if (tries === 2) throw error
    }
  }
  // The password first, while no keyboard is up: on an iPad the keyboard
  // the address raises covers the password field, and a tap aimed there
  // would land on a key, sending what follows to the address instead.
  if (ios) await tapBox(device, await fieldBox(device, 'SecureTextField'))
  else await device.tapOn({ text: 'Password' })
  await typeKeys(device, ios, account.password)
  // The address field sits above any keyboard.
  if (ios) await tapBox(device, await fieldBox(device, 'TextField'))
  else await device.tapOn({ text: 'E-mail address' })
  await typeKeys(device, ios, account.email)
  // The address field signs in from the keyboard in the password form,
  // whose own keys cover the Sign in button.
  await device.pressKey('Enter')
  // Signed in, the form is gone (the title may still read "Sign in").
  // No screenshot here: the form holds the password.
  if (await gone(device, 10000)) return
  // A keyboard whose return key does not submit: the button, below the
  // header's title of the same name.
  await device.hideKeyboard()
  const button = flatten((await device.hierarchy()) as Node)
    .filter(node => (node.accessibilityText ?? node.text) === 'Sign in')
    .map(boxOf)
    .filter((box): box is Box => box != null)
    .sort((a, b) => b.y - a.y)[0]
  if (button != null)
    await device.tapOn({
      point: `${Math.round(button.x + button.width / 2)},${Math.round(
        button.y + button.height / 2
      )}`
    })
  if (await gone(device, 30000)) return
  // What the form says, without its fields: they hold the account.
  const said = flatten((await device.hierarchy()) as Node)
    .map(node => node.text)
    .filter(
      (text): text is string =>
        text != null &&
        text !== '' &&
        text !== account.email &&
        !text.includes(account.password)
    )
  throw new Error(`still signing in: ${said.join(' | ')}`)
}

/**
 * The sign-in form's field of `type` on iOS: the secure one is the
 * password, the topmost plain one the address.
 */
async function fieldBox(device: any, type: string): Promise<Box> {
  const box = flatten((await device.hierarchy()) as Node)
    .filter(node => node.type === type)
    .map(boxOf)
    .filter((found): found is Box => found != null)
    .sort((x, y) => x.y - y.y)[0]
  if (box == null) throw new Error(`no ${type} on screen`)
  return box
}

async function tapBox(device: any, box: Box): Promise<void> {
  await device.tapOn({
    point: `${Math.round(box.x + box.width / 2)},${Math.round(
      box.y + box.height / 2
    )}`
  })
}

async function gone(device: any, timeout: number): Promise<boolean> {
  try {
    await device.assertNotVisible({ text: 'E-mail address', timeout })
    return true
  } catch {
    return false
  }
}

/** The scene's Cancel and its field, and the screen's height. */
async function boxes(
  device: any
): Promise<{ cancel: Box; field: Box; screen: number }> {
  const nodes = flatten((await device.hierarchy()) as Node)
  const cancel = boxOf(
    nodes.find(node => (node.accessibilityText ?? node.text) === 'Cancel')
  )
  const field = boxOf(nodes.find(node => node.id === 'Player search field'))
  if (cancel == null || field == null)
    throw new Error('Add Player’s Cancel or field is not on screen')
  return { cancel, field, screen: screenHeight(nodes) }
}

/**
 * How far down the screen a keyboard reaches, where the hierarchy does not
 * say: two-thirds on a phone held upright, under half on a tablet held
 * sideways, whose keyboard covers more than half of it.
 */
function keyboardReach(nodes: Node[]): number {
  const root = boxOf(nodes[0])
  return root != null && root.width > root.height ? 0.45 : 0.65
}

/** The screen's height: the window's, not its scrolled content's. */
function screenHeight(nodes: Node[]): number {
  const root = boxOf(nodes[0])
  if (root != null && root.height > 0) return root.y + root.height
  return Math.max(
    ...nodes.map(node => {
      const box = boxOf(node)
      return box == null ? 0 : box.y + box.height
    })
  )
}

/**
 * Taps the row whose words are exactly `title`, scrolled clear of the
 * floating tab bar: iOS matches text by what it contains, and the account's
 * own avatar can hold the same words.
 */
async function tapRow(device: any, title: string): Promise<void> {
  for (let tries = 0; ; ++tries) {
    const nodes = flatten((await device.hierarchy()) as Node)
    const screen = screenHeight(nodes)
    const row = nodes
      .filter(node => node.text === title || node.accessibilityText === title)
      .map(boxOf)
      .find((box): box is Box => box != null)
    if (row != null && row.y + row.height < screen * 0.75) {
      await device.tapOn({
        point: `${Math.round(row.x + row.width / 2)},${Math.round(
          row.y + row.height / 2
        )}`
      })
      return
    }
    if (tries === 6) throw new Error(`no ${title} row clear of the tab bar`)
    // Not drawn yet: wait before scrolling.
    if (row == null && tries < 2) {
      await new Promise(resolve => setTimeout(resolve, 3000))
      continue
    }
    await device.swipe({ start: '50%, 60%', end: '50%, 35%' })
    await new Promise(resolve => setTimeout(resolve, 800))
  }
}
