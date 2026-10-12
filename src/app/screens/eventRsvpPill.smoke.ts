import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import {
  androidSmokeRecording,
  watchSmokeRecorder
} from '../../test/smokeRecorder'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
async function main(): Promise<void> {
  const platform = required('TEST_PLATFORM')
  assert(['ios', 'android'].includes(platform))
  const device = required('TEST_DEVICE')
  const appId = required('TEST_APP_ID')
  const artifacts = resolve(required('EVENT_INFO_ARTIFACTS'))
  const load = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = load('maestro-d')
  execFileSync(required('MAESTRO_D_BIN'), ['ps'], { stdio: 'inherit' })
  console.log(`${platform} pill smoke device: ${device}`)
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: required('MAESTRO_D_BIN')
  })
  let iosRecording: ReturnType<typeof watchSmokeRecorder> | undefined
  let androidControl: ReturnType<typeof androidSmokeRecording> | undefined
  let stopApp: (() => Promise<unknown>) | undefined
  const recording = join(artifacts, `${platform}-pill.mp4`)
  const androidRecording = '/sdcard/teamstation-event-rsvp-smoke.mp4'
  try {
    const m = await daemon.attach({
      device,
      platform,
      appId,
      noAppInstall: true
    })
    stopApp = async () => await m.stopApp({ appId })
    await m.launchApp({ appId })
    await m.assertVisible({ text: 'Are you going?', timeout: 10000 })
    console.log('Pill fixture visible')
    if (platform === 'android') {
      // This driver records to the device; transfer the finished clip below.
      androidControl = androidSmokeRecording(
        {
          start: async () => await m.startRecording({ path: androidRecording }),
          stop: async () => await m.stopRecording()
        },
        () => {
          execFileSync(required('ADB_BIN'), [
            '-s',
            device,
            'shell',
            'rm',
            '-f',
            androidRecording
          ])
        }
      )
      await androidControl.start()
    } else {
      iosRecording = watchSmokeRecorder(
        spawn('xcrun', ['simctl', 'io', device, 'recordVideo', recording], {
          stdio: 'inherit'
        })
      )
      await Promise.race([
        iosRecording.completion,
        new Promise(resolve => setTimeout(resolve, 500))
      ])
    }
    await m.dragAndDrop({
      from: { id: 'event-rsvp-101-1' },
      to: { id: 'event-rsvp-101-0' },
      holdDuration: 100,
      duration: 600
    })
    await m.assertVisible({ text: 'Response: yes', timeout: 5000 })
    await m.tapOn({ id: 'event-rsvp-101-1' })
    await m.assertVisible({ text: 'Response: maybe', timeout: 5000 })
    await m.tapOn({ id: 'event-rsvp-101-2' })
    await m.assertVisible({ text: 'Response: no', timeout: 5000 })
    await m.tapOn({ id: 'event-rsvp-101-0' })
    await m.assertVisible({ text: 'Response: yes', timeout: 5000 })
    await m.waitForAnimationToEnd()
    writeFileSync(join(artifacts, `${platform}-pill.png`), await m.screenshot())
    if (platform === 'android') {
      await androidControl!.stop()
      execFileSync(required('ADB_BIN'), [
        '-s',
        device,
        'pull',
        androidRecording,
        recording
      ])
      await androidControl!.dispose()
      androidControl = undefined
    } else {
      await iosRecording!.stop()
      iosRecording = undefined
    }
    await m.stopApp({ appId })
    stopApp = undefined
    console.log(
      `${platform}: single brief drag and Yes/Maybe/No/Yes capsule smoke passed`
    )
  } finally {
    await androidControl?.dispose().catch((error: unknown) => {
      console.error('Android recorder cleanup:', error)
    })
    await iosRecording?.stop().catch((error: unknown) => {
      console.error('Recorder cleanup:', error)
    })
    await stopApp?.().catch((error: unknown) => {
      console.error('App cleanup:', error)
    })
    await daemon.detach(device)
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
