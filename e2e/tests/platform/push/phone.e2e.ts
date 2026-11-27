import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import { pointAtStack } from '../../../rigs/app/pointAtStack'
import { pushRun } from '../../../rigs/push/pushRun'

/**
 * N5 on an Android phone and N6 on an iPhone, in the caller's build pointed
 * at the stack, whose push capture takes every push the server sends
 * (`e2e/rigs/push/pushRun.ts`): a DM and a mention notify the phone and open
 * their conversation, and a reminder for an RSVPed event opens it. A
 * notification reaching the lock screen needs a real phone. The steps' logs
 * and screenshots are under `notifications/` in the run directory.
 */
export default defineHarness({
  id: 'platform/push/phone',
  title:
    'A DM, a mention and an RSVPed event’s reminder notify the phone, decrypted on it, and a tap opens what each is about',
  kind: 'e2e',
  covers: [
    'android/app/src/*/java/app/teamstation/app/push/**',
    'e2e/rigs/push/**',
    'ios/TeamStation/Push/**',
    'ios/TeamStationNotifications/**',
    'mobile/test/teamStationAppNotifications.e2e.ts',
    'scripts/push-coverage.mjs',
    'src/app/platform/notificationSwitches*',
    'src/app/platform/pushDevice*',
    'src/app/platform/pushState.ts',
    'src/app/push/**',
    'src/server/push/**',
    'src/server/routes/push.ts'
  ],
  stack: 'isolated',
  fixtures: [],
  // The run's push queue has a fixed Valkey prefix: one at a time.
  exclusive: true,
  surfaces: {
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone', 'push'], simulator: 'never' }
      ]
    },
    'ios-app': {
      devices: [
        { role: 'phone', needs: ['ios-phone', 'push'], simulator: 'never' }
      ]
    }
  },
  services: ['push-capture'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'dms-mentions-reminders': async ctx => {
      const kind =
        ctx.surface === 'ios-app' ? 'teamstation-ios' : 'teamstation-android'
      const appId = ctx.app(kind)
      const m = ctx.attached('phone')
      // The runner pointed the caller's build at the stack; a fresh launch
      // keeps it there.
      await m.launchApp({ appId, stopApp: true })
      await pointAtStack(m, ctx.stack.origin, appId)
      await pushRun(ctx, ctx.surface === 'ios-app' ? 'ios' : 'android')
      expect(ctx.surface).oneOf(['ios-app', 'android-app'])
    }
  }
})
