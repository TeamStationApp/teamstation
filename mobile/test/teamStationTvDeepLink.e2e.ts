import { strict as assert } from 'node:assert'

import { attach } from './maestroD'

/**
 * Signed-device TV universal/app-link handoff. Install and sign in to the
 * matching release-signed phone build before running. Claim the device first.
 * TS_E2E_APP_ID, TS_E2E_DEVICE, MAESTRO_D and E2E_ARTIFACT_DIR select the device.
 * TS_E2E_API_ORIGIN is the issuing API; TS_E2E_APP_ORIGIN is its registered
 * phone link origin. No domain-verification override is applied by this test.
 *
 * This exercises an OS link-open event, not camera QR recognition. Separately
 * scan the displayed QR with the system camera and repeat without the app;
 * an openLink result alone does not prove those scenarios or OS association.
 */
function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}
function origin(key: string): string {
  const value = required(key)
  const url = new URL(value)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.origin, value)
  return value
}

async function main(): Promise<void> {
  const appId = required('TS_E2E_APP_ID')
  assert.ok(['app.teamstation.app', 'app.teamstation.develop'].includes(appId))
  const apiOrigin = origin('TS_E2E_API_ORIGIN')
  const appOrigin = origin('TS_E2E_APP_ORIGIN')
  const response = await fetch(`${apiOrigin}/api/v1/auth/tv/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'Apple TV', appOrigin })
  })
  assert.equal(response.status, 200)
  const request = await response.json()
  const qr = new URL(request.qrUrl)
  assert.equal(qr.origin, appOrigin)
  assert.equal(qr.pathname, '/tv-login')
  assert.ok(qr.searchParams.get('server'))
  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: required('TS_E2E_DEVICE'),
    appId
  })
  try {
    await m.launchApp({ appId, stopApp: true })
    await m.openLink({ link: request.qrUrl })
    await m.extendedWaitUntil({
      visible: { text: 'Sign this TV in to your TeamStation account?' },
      timeout: 30000
    })
    await m.shot('tv-app-confirmation')
    await m.tapOn({ text: 'Login', exact: true })
    await m.extendedWaitUntil({
      visible: { text: 'Your TV is signed in' },
      timeout: 30000
    })
    await m.shot('tv-app-approved')
    console.log('TV request opened confirmation and was explicitly approved')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
