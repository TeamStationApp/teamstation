import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'
import { generateVAPIDKeys } from 'web-push'

import { asServerConfig } from '../serverConfigSchema'
import { pushSettings, pushTransports } from './config'

describe('the push settings', function () {
  const p8Key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const apns = {
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    p8Key,
    topic: 'app.example.test'
  }
  const fcm = {
    projectId: 'demo-project',
    clientEmail: 'push@demo-project.iam.example.test',
    privateKey: rsaKey
  }
  const webPush = {
    ...generateVAPIDKeys(),
    subject: 'mailto:push@example.test'
  }
  const dir = mkdtempSync(join(tmpdir(), 'ts-push-config-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is all off when the config says nothing', function () {
    expect(pushSettings(asServerConfig({}))).deep.equals({
      apns: null,
      fcm: null,
      webPush: null,
      iosFiltering: false,
      logFile: null,
      chatHoldSeconds: 15
    })
    expect(pushSettings(asServerConfig({ push: {} }))).deep.equals({
      apns: null,
      fcm: null,
      webPush: null,
      iosFiltering: false,
      logFile: null,
      chatHoldSeconds: 15
    })
    expect(pushTransports(pushSettings(asServerConfig({})))).deep.equals({})
  })

  it('turns on each service that has every one of its keys', function () {
    const settings = pushSettings(
      asServerConfig({
        push: {
          apns,
          fcm,
          webPush,
          iosFiltering: true,
          logFile: '/var/app/push.jsonl',
          chatHoldSeconds: 1
        }
      })
    )
    expect(settings).deep.equals({
      apns,
      fcm,
      webPush,
      iosFiltering: true,
      logFile: '/var/app/push.jsonl',
      chatHoldSeconds: 1
    })
    // A hold below nothing is none.
    expect(
      pushSettings(asServerConfig({ push: { chatHoldSeconds: -5 } }))
        .chatHoldSeconds
    ).equals(0)
    const off = pushSettings(
      asServerConfig({
        push: {
          apns: { ...apns, p8Key: '' },
          fcm: { ...fcm, clientEmail: '  ' },
          webPush: { ...webPush, privateKey: '' }
        }
      })
    )
    expect(off).deep.equals({
      apns: null,
      fcm: null,
      webPush: null,
      iosFiltering: false,
      logFile: null,
      chatHoldSeconds: 15
    })
  })

  it('refuses a push section that leaves out a key', function () {
    expect(() =>
      asServerConfig({ push: { apns: { keyId: 'KEY1234567' } } })
    ).to.throw()
  })

  it('makes a transport for each service that is on', function () {
    const all = pushTransports(
      pushSettings(asServerConfig({ push: { apns, fcm, webPush } }))
    )
    expect(Object.keys(all).sort()).deep.equals(['android', 'ios', 'web'])
    const webOnly = pushTransports(
      pushSettings(asServerConfig({ push: { webPush } }))
    )
    expect(Object.keys(webOnly)).deep.equals(['web'])
  })

  it('leaves off only the service whose key cannot be read, and says so', function () {
    const said: string[] = []
    const transports = pushTransports(
      pushSettings(
        asServerConfig({
          push: {
            apns: { ...apns, p8Key: p8Key.slice(0, 60) },
            fcm: { ...fcm, privateKey: 'not a key' },
            webPush
          }
        })
      ),
      {},
      line => said.push(line)
    )
    expect(Object.keys(transports)).deep.equals(['web'])
    expect(said).length(2)
    expect(said[0]).match(/^push: APNs is off, its key cannot be read: /)
    expect(said[1]).match(/^push: FCM is off, its key cannot be read: /)
    const fcmOnly = pushTransports(
      pushSettings(
        asServerConfig({
          push: { apns: { ...apns, p8Key: 'garbage' }, fcm }
        })
      ),
      {},
      () => undefined
    )
    expect(Object.keys(fcmOnly)).deep.equals(['android'])
  })

  it('writes every platform to the log file when there is one', async function () {
    const file = join(dir, 'push.jsonl')
    const transports = pushTransports(
      pushSettings(asServerConfig({ push: { logFile: file } }))
    )
    expect(Object.keys(transports).sort()).deep.equals([
      'android',
      'ios',
      'web'
    ])
    expect(
      await transports.android!.send(
        {
          id: 'psh_one',
          userId: 'usr_one',
          platform: 'android',
          address: 'debug-00000000-0000-4000-8000-000000000001',
          environment: 'production'
        },
        { platform: 'android', priority: 'high', data: { payload: '{}' } }
      )
    ).deep.equals({ status: 'sent' })
    const record = JSON.parse(readFileSync(file, 'utf8'))
    expect(record.registrationId).equals('psh_one')
    expect(record.message.data).deep.equals({ payload: '{}' })
  })
})
