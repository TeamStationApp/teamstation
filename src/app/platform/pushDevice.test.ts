import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { browserPushDevice, pushDevice } from './pushDevice'

type Permission = 'granted' | 'denied' | 'default'

/** A browser's `Notification`, answering a request with `answer`. */
function notification(
  permission: Permission,
  answer: Permission | Error
): {
  permission: Permission
  asked: number
  requestPermission: () => Promise<Permission>
} {
  const api = {
    permission,
    asked: 0,
    requestPermission: async (): Promise<Permission> => {
      api.asked++
      if (answer instanceof Error) throw answer
      api.permission = answer
      return answer
    }
  }
  return api
}

describe('notifications in a browser', function () {
  afterEach(function () {
    Reflect.deleteProperty(globalThis, 'Notification')
  })

  it('reads the browser’s permission without asking', async function () {
    for (const [permission, state] of [
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['default', 'prompt']
    ] as const) {
      const api = notification(permission, 'granted')
      const device = browserPushDevice(() => api)
      expect(await device.state()).equals(state)
      expect(await device.sync()).equals(state)
      expect(api.asked).equals(0)
    }
  })

  it('asks only when not asked yet, and answers what the person chose', async function () {
    const allowed = notification('default', 'granted')
    expect(await browserPushDevice(() => allowed).enable()).equals('granted')
    const refused = notification('default', 'denied')
    expect(await browserPushDevice(() => refused).enable()).equals('denied')
    // A dismissed prompt is still unanswered.
    const dismissed = notification('default', 'default')
    expect(await browserPushDevice(() => dismissed).enable()).equals('prompt')
    const blocked = notification('denied', 'granted')
    expect(await browserPushDevice(() => blocked).enable()).equals('denied')
    expect(blocked.asked).equals(0)
    // A browser that throws instead of asking is left unanswered.
    const broken = notification('default', new Error('No prompt'))
    expect(await browserPushDevice(() => broken).enable()).equals('prompt')
    expect(broken.asked).equals(1)
  })

  it('cannot notify in a browser without notifications', async function () {
    expect(await pushDevice.state()).equals('unsupported')
    expect(await pushDevice.enable()).equals('unsupported')
    const api = notification('granted', 'granted')
    Object.assign(globalThis, { Notification: api })
    expect(await pushDevice.state()).equals('granted')
  })
})
