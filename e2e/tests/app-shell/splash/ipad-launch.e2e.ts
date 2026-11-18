import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import {
  compareNow,
  defineSplash,
  frames,
  launchFrozen,
  readReport,
  type SplashTarget
} from '../../../rigs/app/splash'

const landscape = async (device: any): Promise<void> => {
  await device.setOrientation('LANDSCAPE_LEFT')
}
const portrait = async (device: any): Promise<void> => {
  await device.setOrientation('PORTRAIT')
}

/**
 * The launch splash on an iPad, in each orientation: the same animation,
 * cropping less of the stadium, and laid out again when the iPad turns while
 * it plays.
 */
export default defineSplash({
  behaviour: 'ipad-launch',
  title:
    'The iPad launch splash crops less of the stadium in both orientations and survives a turn',
  surface: 'ios-app',
  needs: ['ipad'],
  covers: [
    'mobile/apps/common/TeamStationSplash/**',
    'mobile/icons/splash/**',
    'ios/TeamStation/AppDelegate.swift',
    'ios/TeamStation/LaunchScreen.storyboard'
  ],
  target: {
    platform: 'ios',
    appId: 'app.teamstation.app',
    statusBar: 32,
    name: 'ipad'
  },
  scenarios: {
    'frames-landscape': async (ctx, device, target: SplashTarget) => {
      await landscape(device)
      await frames(ctx, device, { ...target, name: 'ipad-landscape' })
    },
    'frames-portrait': async (ctx, device, target: SplashTarget) => {
      await portrait(device)
      await frames(ctx, device, { ...target, name: 'ipad-portrait' })
    },
    rotate: async (ctx, device, target: SplashTarget) => {
      // Frozen mid-animation in portrait, then turned: the splash must lay
      // itself out again for landscape and draw what the reference draws at
      // that size. (Its animations carrying on through a size change are
      // SplashViewTests.testANewSizeMovesTheLayersAndKeepsPlaying.)
      await portrait(device)
      const upright = await launchFrozen(device, target, 0.7)
      expect(upright.height).to.be.above(upright.width)
      await landscape(device)
      let report = upright
      for (let tries = 0; tries < 40 && report.width < report.height; tries++)
        report = readReport(String(await device.hierarchyRaw())) ?? report
      expect(
        report.width,
        'the splash never laid itself out for landscape'
      ).to.be.above(report.height)
      writeFileSync(
        ctx.artifact('splash-ipad-rotating.png'),
        await device.screenshot()
      )
      await compareNow(
        ctx,
        device,
        { ...target, name: 'ipad-rotated' },
        report,
        0.7
      )
    }
  }
})
