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
  const recording = join(artifacts, `${platform}-smoke.mp4`)
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
    await m.assertVisible({ text: 'ARE YOU GOING?', timeout: 10000 })
    console.log('Pill fixture visible')
    if (process.env.TEST_PICKER_ONLY === '1') {
      await m.scrollUntilVisible({
        element: { id: 'event-schedule-time' },
        direction: 'DOWN',
        maxScrolls: 6
      })
      await m.tapOn({ id: 'event-schedule-time' })
      await m.assertVisible({ id: 'event-time-hour-11', timeout: 5000 })
      await m.assertVisible({ id: 'event-time-minute-30', timeout: 5000 })
      writeFileSync(
        join(artifacts, `${platform}-time-picker.png`),
        await m.screenshot()
      )
      await m.tapOn({ id: 'event-time-minute-35' })
      await m.tapOn({ text: 'Use time' })
      await m.scrollUntilVisible({
        element: { id: 'smoke-schedule' },
        direction: 'DOWN',
        maxScrolls: 6
      })
      await m.assertVisible({ text: 'Schedule: 23:35 · 2032-03-01' })
      writeFileSync(
        join(artifacts, `${platform}-smoke.png`),
        await m.screenshot()
      )
      await m.stopApp({ appId })
      stopApp = undefined
      console.log(
        `${platform}: targeted saved-time picker correction passed; capsule/map were already proven`
      )
      return
    }
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
    await m.scrollUntilVisible({
      element: { id: 'event-location-map' },
      direction: 'DOWN',
      maxScrolls: 6
    })
    writeFileSync(join(artifacts, `${platform}-map.png`), await m.screenshot())
    await m.scrollUntilVisible({
      element: { id: 'event-schedule-date' },
      direction: 'DOWN',
      maxScrolls: 6
    })
    await m.tapOn({ id: 'event-schedule-date' })
    await m.assertVisible({ text: 'Choose date' })
    await m.tapOn({ text: 'Cancel date picker' })
    await m.scrollUntilVisible({
      element: { id: 'event-schedule-time' },
      direction: 'DOWN',
      maxScrolls: 6
    })
    await m.tapOn({ id: 'event-schedule-time' })
    await m.assertVisible({ text: 'Choose time' })
    await m.tapOn({ id: 'event-time-minute-35' })
    await m.tapOn({ text: 'Use time' })
    await m.scrollUntilVisible({
      element: { id: 'smoke-schedule' },
      direction: 'DOWN',
      maxScrolls: 6
    })
    await m.assertVisible({ text: 'Schedule: 23:35 · 2032-03-01' })
    writeFileSync(
      join(artifacts, `${platform}-smoke.png`),
      await m.screenshot()
    )
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
      `${platform}: single brief capsule, calendar/time and map smoke passed`
    )
  } finally {
    if (platform === 'android' && androidControl != null) {
      await androidControl.stop().catch(() => undefined)
      // Keep a partial smoke recording when a later assertion fails.
      try {
        execFileSync(required('ADB_BIN'), [
          '-s',
          device,
          'pull',
          androidRecording,
          recording
        ])
      } catch {
        /* Cleanup below still removes only this test's recording. */
      }
    }
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
