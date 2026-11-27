import { writeFileSync } from 'node:fs'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { openPhoneScorer, scorePath } from '../../../rigs/scoring/phoneScorer'

/**
 * The native scoring field with two positions empty (`defense-gaps`: the
 * Hawks have nobody at P or LF), driven through the real field, never a
 * standalone picker: the whole field and every label draw; an empty and an
 * occupied position open the defensive sheet; Create Player cancels and
 * creates a named player who returns to the sheet; placeholders are made;
 * a bench player substitutes and vacates his old position; a complete
 * defense clears the warning; a pitch renders and the field still takes a
 * tap after it; Undo takes the pitch back.
 */

async function fieldAssignments(ctx: HarnessContext): Promise<void> {
  const world = await ctx.fixture('defense-gaps')
  const app = await openPhoneScorer(ctx, 'scorer')
  const { m } = app
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text: `^${text}$`, timeout: 15000 })
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    await m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
    writeFileSync(
      ctx.artifact(`${name}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  const fieldReady = async (): Promise<void> => {
    await m.assertVisible({ text: '^Assign P$', timeout: 60000 })
    await m.assertVisible({ text: '^Assign LF$', timeout: 15000 })
    for (const name of [
      'Mike T',
      'Shohei O',
      'Aaron J',
      'Bryce H',
      'Freddie F',
      'Juan S',
      'Bobby W'
    ])
      await m.assertVisible({ text: `^${name}$`, timeout: 15000 })
  }
  await app.open(scorePath(world.ids.game))
  await m.assertVisible({ text: 'Assign a pitcher', timeout: 60000 })
  const start = Date.now()
  await fieldReady()
  writeFileSync(
    ctx.artifact('field-ready.log'),
    `Field ready ${Date.now() - start}ms after setup warning\n`
  )
  await capture('field-ready')
  await tap('Assign P')
  await m.assertVisible({ text: '^Assign pitcher$', timeout: 15000 })
  await capture('field-tap-picker')
  await m.assertVisible({ text: '^Bench$' })
  await m.assertVisible({ text: '^Fielders$' })
  await tap('Create Player')
  await m.assertVisible({ text: '^First Name$' })
  await tap('Cancel')
  await m.assertVisible({ text: '^Assign pitcher$' })
  await tap('Create Player')
  for (const [label, value] of [
    ['First Name', 'Clayton'],
    ['Last Name', 'Kershaw'],
    ['Jersey Number', '22']
  ]) {
    await tap(label)
    await m.inputText({ text: value })
  }
  await m.hideKeyboard()
  await tap('Create Player')
  await m.assertVisible({ text: '^Assign pitcher$' })
  await m.assertVisible({ text: 'Assign P #22 Clayton K' })
  await capture('created-player-return')
  await tap('Create Player')
  await m.waitForAnimationToEnd({ timeout: 3000 })
  await tap('Throws')
  await m.hideKeyboard()
  await m.swipe({ start: '25%, 55%', end: '25%, 20%', duration: 400 })
  await m.scrollUntilVisible({
    element: { text: '^Create Placeholder Player$' },
    direction: 'DOWN',
    timeout: 15000
  })
  await tap('Create Placeholder Player')
  await m.assertVisible({ text: '^Select number of players to create\\.$' })
  await tap('Create')
  await m.assertVisible({ text: '^Assign pitcher$' })
  await m.assertVisible({ text: 'Assign P Hawks A' })
  await capture('placeholder-return')
  // The field keeps short names; the sheet names a roster player in full
  // when the signed-in scorer may read him in full, and short otherwise.
  await m.scrollUntilVisible({
    element: { text: 'Assign P #27 Mike T\\w*' },
    direction: 'DOWN',
    timeout: 15000
  })
  await tap('Assign P #27 Mike T\\w*')
  await m.assertVisible({ text: '^Assign C$', timeout: 15000 })
  await capture('catcher-vacated')
  await tap('Assign C')
  await m.assertVisible({ text: '^Assign catcher$' })
  await tap('Assign C #22 Clayton K')
  await m.assertNotVisible({ text: '^Assign C$', timeout: 15000 })
  await m.assertVisible({ text: '^Clayton Kershaw$', timeout: 15000 })
  await tap('Clayton Kershaw')
  await m.assertVisible({ text: '^Assign catcher$', timeout: 15000 })
  await capture('occupied-fielder-tap')
  await tap('Cancel')
  await tap('Assign LF')
  await m.assertVisible({ text: '^Assign left field$' })
  await tap('Assign LF #50 Mookie B\\w*')
  await m.assertNotVisible({ text: 'Assign a pitcher', timeout: 15000 })
  await m.assertVisible({ text: '^Mookie B$', timeout: 15000 })
  await capture('complete-defense')
  await tap('Ball')
  await m.assertVisible({ text: '^Undo Ball$', timeout: 15000 })
  // A history entry alone does not prove the native presentation finished.
  await m.assertVisible({ text: '^Ball$', enabled: true, timeout: 60000 })
  await capture('pitch-rendered')
  // This tap must reach the live scene after the animation, not a stale label.
  await tap('Clayton Kershaw')
  await m.assertVisible({ text: '^Assign catcher$', timeout: 15000 })
  await capture('field-after-pitch-picker')
  await tap('Cancel')
  await tap('Undo Ball')
  await m.assertVisible({ text: '^Undo Set team roster$', timeout: 15000 })
  await m.assertVisible({ text: '^Mookie B$', timeout: 15000 })
  await capture('pitch-undone')
}

export default defineHarness({
  id: 'scoring/defensive-native/field-assignments',
  title: 'The native field assigns, creates and substitutes defenders',
  kind: 'e2e',
  covers: [
    'src/app/scoring/DefensiveRosterSheet.tsx',
    'src/app/scoring/DefensiveField.tsx',
    'src/app/scoring/currentSetup.ts',
    'src/app/scoring/placeholderPlayers.ts',
    'src/app/field/NativeNameplates.tsx'
  ],
  stack: 'isolated',
  fixtures: ['defense-gaps'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      // The scoring field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'field-assignments': fieldAssignments
  }
})
