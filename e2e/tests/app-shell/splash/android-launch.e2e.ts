import { execFileSync } from 'node:child_process'

import type { E2eContext } from '../../../core/spec'
import {
  defineSplash,
  dismissal,
  frames,
  resume
} from '../../../rigs/app/splash'

/**
 * Puts the emulator's status bar in SystemUI demo mode, so its clock, battery
 * and notifications are the same in every run and every captured frame.
 */
function demoMode(ctx: E2eContext, command: 'enter' | 'exit'): void {
  const serial = ctx.device('app')
  const adb = (...args: string[]): void => {
    execFileSync('adb', ['-s', serial, 'shell', ...args])
  }
  if (command === 'exit') {
    adb(
      'am',
      'broadcast',
      '-a',
      'com.android.systemui.demo',
      '-e',
      'command',
      'exit'
    )
    return
  }
  adb('settings', 'put', 'global', 'sysui_demo_allowed', '1')
  const demo = (...extras: string[]): void => {
    adb(
      'am',
      'broadcast',
      '-a',
      'com.android.systemui.demo',
      '-e',
      'command',
      ...extras
    )
  }
  demo('enter')
  demo('clock', '-e', 'hhmm', '0941')
  demo('battery', '-e', 'level', '100', '-e', 'plugged', 'false')
  demo('notifications', '-e', 'visible', 'false')
}

/**
 * The launch splash on an Android phone: the system's dark starting window
 * hands over to frame 0, frozen frames match the reference page at the
 * phone's own size and density, the splash leaves for React Native's first
 * screen, and coming back from the background shows no splash. Runs a Release
 * build on an emulator.
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
    appId: 'app.teamstation.app',
    statusBar: 52,
    name: 'android'
  },
  prepare: async ctx => {
    demoMode(ctx, 'enter')
  },
  scenarios: {
    frames: async (ctx, device, target) => {
      try {
        await frames(ctx, device, target)
      } finally {
        demoMode(ctx, 'exit')
      }
    },
    dismiss: async (ctx, device, target) => {
      try {
        await dismissal(device, target)
        await ctx.checkpoint('splash-android-dismissed', {
          expect: [{ text: '^TeamStation$' }, { id: 'tsSplash', absent: true }]
        })
      } finally {
        demoMode(ctx, 'exit')
      }
    },
    'warm-resume': async (ctx, device, target) => {
      try {
        await resume(ctx, device, target)
        await device.assertNotVisible({ id: 'tsSplash', timeout: 500 })
        await ctx.checkpoint('splash-android-resumed', {
          expect: [{ id: 'tsSplash', absent: true }]
        })
      } finally {
        demoMode(ctx, 'exit')
      }
    }
  }
})
