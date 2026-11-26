import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { isHubDevice } from '../../../core/maestro'
import { iosIsSimulator } from '../../../core/prepare'
import { defineE2e } from '../../../core/spec'
import {
  type Box,
  boxOf,
  flatten,
  type Node
} from '../../../rigs/app/keyboardDock'
import { appLink, openInApp, setServer } from '../../../rigs/app/setServer'
import { scoringFixtureLink } from '../../../rigs/scoringFixtureLink'
import { remotePitch } from '../../../rigs/scoringLayout'
import { signOutApp } from '../../../rigs/streaming/soakSignIn'

export default defineE2e({
  id: 'scoring/layout/stacked',
  title:
    'The native scoring deck sits above its remote updates and bottom strip',
  kind: 'e2e',
  covers: [
    'src/app/field/BaseballScreen.tsx',
    'src/app/field/scoringFrame.ts',
    'src/app/field/NativeNameplates.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['api', 'web'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    native: async ctx => {
      const world = await ctx.fixture('coach-game')
      const platform = ctx.surface === 'ios-app' ? 'ios' : 'android'
      const udid = ctx.device('phone')
      const appId = 'app.teamstation.develop'
      const device = await ctx.attach('phone', { platform, appId })
      const hub = isHubDevice(udid)
      const options = {
        platform,
        udid,
        appId,
        device,
        hub,
        simulator: platform === 'ios' && !hub && iosIsSimulator(udid)
      } as const
      await setServer({ ...options, origin: ctx.stack.origin })
      if (
        (await device
          .assertVisible({ text: 'Account, .*', timeout: 2000 })
          .then(
            () => true,
            () => false
          )) === true
      ) {
        await signOutApp(device)
      }
      if (hub) {
        const link = await scoringFixtureLink(
          ctx,
          world.accounts.scorekeeper.email,
          platform
        )
        try {
          await openInApp({ ...options, link: appLink(link) })
        } catch {
          throw new Error('The leased phone could not open its fixture sign-in')
        }
        await device.tapOn({
          id: 'signInLinkSignIn',
          optional: true,
          timeout: 4500
        })
        await device.assertVisible({ text: 'Your Home', timeout: 35000 })
      } else await ctx.signIn('scorekeeper', device)
      await openInApp({
        ...options,
        link: appLink(`games/${world.ids.game}/score`)
      })
      await device.assertVisible({ text: '^Ball$', timeout: 60000 })
      const boxes = async (): Promise<
        Record<'root' | 'holder' | 'face' | 'deck' | 'strip', Box>
      > => {
        const nodes = flatten((await device.hierarchy()) as Node)
        const rect = (id: string): Box => {
          const box = boxOf(nodes.find(n => n.id?.split('/').pop() === id))
          if (box == null) throw new Error(`Missing bounds for ${id}`)
          return box
        }
        return {
          root: rect('baseball-screen'),
          holder: rect('scoring-field-holder'),
          face: rect('scoring-catcher-face'),
          deck: rect('scoring-deck'),
          strip: rect('scoring-notice-strip')
        }
      }
      const peer = await remotePitch(ctx, world)
      const orientations =
        process.env.TS_SCORING_ROTATE === '1'
          ? (['PORTRAIT', 'LANDSCAPE'] as const)
          : (['PORTRAIT'] as const)
      try {
        for (const orientation of orientations) {
          await device.setOrientation({ orientation })
          await device.assertVisible({
            id: 'scoring-catcher-face',
            timeout: 45000
          })
          const first = await boxes()
          expect(first.root.width > first.root.height).equals(
            orientation === 'LANDSCAPE'
          )
          await peer.pitch()
          await device.assertVisible({ text: '.*Score P.*', timeout: 45000 })
          const after = await boxes()
          expect(after).deep.equals(first)
          const { face, deck, strip, holder, root } = after
          const scale = deck.height / 120
          expect((deck.y - face.y - face.height) / scale).closeTo(4, 1)
          expect(
            (strip.y + strip.height - root.y - root.height) / scale
          ).closeTo(0, 1)
          expect(strip.height / scale).at.least(39.5)
          expect(holder.height).at.least(root.height - 1)
          expect(holder.y + holder.height).closeTo(root.y + root.height, scale)
          const tree = (await device.hierarchy()) as Node
          const nodes = flatten(tree)
          const panel = boxOf(
            nodes.find(n => n.id?.endsWith('remote-scoring-updates') === true)
          )!
          const body = boxOf(
            nodes.find(
              n => n.id?.endsWith('remote-scoring-update-lines') === true
            )
          )!
          expect((panel.y - deck.y - deck.height) / scale).closeTo(8, 1)
          expect(body.height / scale).at.least(19.5)
          expect(panel.y + panel.height).at.most(strip.y + scale)
          writeFileSync(
            ctx.artifact(
              `stacked-native-${orientation.toLowerCase()}-after.png`
            ),
            await device.screenshot()
          )
          writeFileSync(
            ctx.artifact(
              `stacked-native-${orientation.toLowerCase()}-measurements.json`
            ),
            JSON.stringify(
              { udid, platform, first, after, panel, body },
              null,
              2
            )
          )
        }
      } finally {
        try {
          await device.setOrientation({ orientation: 'PORTRAIT' })
        } finally {
          await peer.close()
        }
      }
    }
  }
})
