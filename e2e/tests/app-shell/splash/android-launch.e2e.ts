import {
  defineSplash,
  dismissal,
  frames,
  resume
} from '../../../rigs/app/splash'

/**
 * The launch splash on an Android phone: the system's dark starting window
 * hands over to frame 0, frozen frames match the reference page at the
 * phone's own size and density, the splash leaves for React Native's first
 * screen, and coming back from the background shows no splash. The rig puts
 * the status bar in demo mode for every frame (maestro-d's setStatusBar).
 */
export default defineSplash({
  behaviour: 'android-launch',
  title:
    'The Android launch splash plays the design, dismisses to the app and skips a resume',
  surface: 'android-app',
  needs: ['android-phone'],
  covers: [
    'android/app/src/main/java/app/teamstation/app/splash/**',
    'android/app/src/main/java/app/teamstation/app/MainActivity.kt',
    'android/app/src/main/res/values/styles.xml',
    'mobile/icons/splash/**'
  ],
  target: {
    platform: 'android',
    statusBar: 52,
    name: 'android'
  },
  scenarios: {
    frames: async (ctx, device, target) => {
      await frames(ctx, device, target)
    },
    dismiss: async (ctx, device, target) => {
      await dismissal(device, target)
      await ctx.checkpoint('splash-android-dismissed', {
        expect: [{ text: '^TeamStation$' }, { id: 'tsSplash', absent: true }]
      })
    },
    'warm-resume': async (ctx, device, target) => {
      await resume(ctx, device, target)
      await device.assertNotVisible({ id: 'tsSplash', timeout: 500 })
      await ctx.checkpoint('splash-android-resumed', {
        expect: [{ id: 'tsSplash', absent: true }]
      })
    }
  }
})
