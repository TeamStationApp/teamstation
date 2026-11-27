import {
  defineSplash,
  dismissal,
  frames,
  resume
} from '../../../rigs/app/splash'

/**
 * The launch splash on an iPhone: frozen frames match the reference page at
 * the phone's own size and scale, the splash leaves for React Native's first
 * screen within 4 s, and coming back from the background shows no splash.
 * Runs on the caller's app, a physical phone first, a simulator where none is free.
 */
export default defineSplash({
  behaviour: 'phone-launch',
  title:
    'The iPhone launch splash plays the design, dismisses to the app and skips a resume',
  surface: 'ios-app',
  needs: ['ios-phone'],
  covers: [
    'mobile/apps/common/TeamStationSplash/**',
    'mobile/icons/splash/**',
    'ios/TeamStation/AppDelegate.swift',
    'ios/TeamStation/LaunchScreen.storyboard'
  ],
  target: {
    platform: 'ios',
    statusBar: 64,
    name: 'phone'
  },
  scenarios: {
    frames,
    dismiss: async (ctx, device, target) => {
      await dismissal(device, target)
      // React Native's own screen: the booting logo, or the sign-in header.
      await ctx.checkpoint('splash-phone-dismissed', {
        expect: [{ text: '^TeamStation$' }, { id: 'tsSplash', absent: true }]
      })
    },
    'warm-resume': async (ctx, device, target) => {
      await resume(ctx, device, target)
      await device.assertNotVisible({ id: 'tsSplash', timeout: 500 })
      await ctx.checkpoint('splash-phone-resumed', {
        expect: [{ id: 'tsSplash', absent: true }]
      })
    }
  }
})
