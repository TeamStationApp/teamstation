import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import { pushRun } from '../../../rigs/push/pushRun'

/**
 * N1–N4 of the notifications plan in the finished web app, in a Chrome of the
 * scenario's own, against an API and web app the run starts on this machine
 * with the chat fixture in a database of their own (`e2e/rigs/push/pushRun.ts`).
 * One story, in order: N1 a browser's switches are its own; N2 a refused
 * browser keeps its switch, says so, and registers once allowed; N3 a DM and a
 * mention notify it, through real Web Push and through the service worker,
 * and nothing else does; N4 a reminder for an RSVPed event, and taps that
 * open it and the DM. The steps' logs and screenshots are under
 * `notifications/` in the run directory.
 */
export default defineE2e({
  id: 'platform/push/browser',
  title:
    "A browser's notification switches are its own, a DM, a mention and an RSVPed event's reminder notify it and nothing else does, and a tap opens what it is about",
  kind: 'e2e',
  covers: [
    'e2e/rigs/push/**',
    'scripts/push-coverage.mjs',
    'scripts/serviceWorkerBuild.mjs',
    'src/app/notifications.e2e.ts',
    'src/app/platform/notificationSwitches*',
    'src/app/platform/pushDevice*',
    'src/app/platform/pushState.ts',
    'src/app/push/**',
    'src/app/web/sw.ts',
    'src/server/push/**',
    'src/server/routes/push.ts'
  ],
  stack: 'none',
  fixtures: [],
  // The run's push queue has a fixed Valkey prefix: one at a time.
  exclusive: true,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'dms-mentions-reminders': async ctx => {
      const run = await pushRun(ctx, 'web')
      expect(run.code, `N1–N4 failed: see ${run.log}`).equals(0)
    }
  }
})
