#!/usr/bin/env node
// Proves the Director process is still running after it was backgrounded while recording.
//
// The debug HUD is gone once another app is in front, so Maestro cannot read rec=1. The
// control server on loopback only answers if the process was not suspended.

const { get } = require('./deviceTarget')

const HOST = process.env.DIRECTOR_DEVICE_ADDRESS ?? '127.0.0.1'
const SLEEP_MS = Number(process.env.DIRECTOR_KEEPALIVE_SLEEP_MS ?? 3000)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

async function dump() {
  const raw = await get(HOST, '/dump-state')
  return JSON.parse(raw)
}

async function main() {
  try {
    await get(HOST, '/health')
  } catch (error) {
    fail(`control server unreachable — process likely suspended: ${error.message}`)
  }

  const first = await dump()
  if (!first.dvr?.isRecording) fail('dump-state: not recording (rec expected 1)')
  if (!first.programAudioPlaying) fail('dump-state: programme audio is not playing (aout expected 1)')
  if (!first.keepAliveInBackground) fail('dump-state: keep-alive is off (bgkeep expected 1)')
  if (!first.pictureInPictureActive) {
    process.stderr.write(
      'warning: dump-state pictureInPictureActive is false — screenshot must still show PiP\n'
    )
  }

  const mixBefore = asNumber(first.audioMixSeconds)
  const segmentsBefore = asNumber(first.dvr?.segmentCount)
  const clockBefore = asNumber(first.clockSeconds)

  await sleep(SLEEP_MS)

  let second
  try {
    second = await dump()
  } catch (error) {
    fail(`control server died while backgrounded: ${error.message}`)
  }

  if (!second.dvr?.isRecording) fail('recording stopped while backgrounded')
  if (!second.programAudioPlaying) fail('programme audio stopped while backgrounded')

  const mixAfter = asNumber(second.audioMixSeconds)
  const segmentsAfter = asNumber(second.dvr?.segmentCount)
  const clockAfter = asNumber(second.clockSeconds)
  const moved =
    mixAfter > mixBefore || segmentsAfter > segmentsBefore || clockAfter > clockBefore + 1
  if (!moved) {
    fail(
      `pipeline frozen while backgrounded mixs=${mixBefore}->${mixAfter} seg=${segmentsBefore}->${segmentsAfter} clock=${clockBefore}->${clockAfter}`
    )
  }

  process.stdout.write(
    `keep-alive ok rec=1 aout=1 bgkeep=1 pip=${second.pictureInPictureActive ? '1' : '0'} ` +
      `mixs=${mixBefore}->${mixAfter} seg=${segmentsBefore}->${segmentsAfter}\n`
  )
}

main().catch(error => fail(error.message))
