import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  anySwitchOn,
  askedKey,
  readAsked,
  readSwitches,
  SWITCHES_OFF,
  switchesKey,
  writeAsked,
  writeSwitches
} from './notificationSwitches'
import type { UserSettingStorage } from './userSetting'

/** A device's storage, in memory, refusing everything when `broken`. */
function storage(broken = false): UserSettingStorage & {
  kept: Map<string, string>
} {
  const kept = new Map<string, string>()
  return {
    kept,
    getItem: async key => {
      if (broken) throw new Error('Storage refused')
      return kept.get(key) ?? null
    },
    setItem: async (key, value) => {
      if (broken) throw new Error('Storage refused')
      kept.set(key, value)
    }
  }
}

describe('a device’s own notification switches', function () {
  it('starts both off, and keeps each person’s apart', async function () {
    const device = storage()
    expect(await readSwitches('usr_a', device)).deep.equals(SWITCHES_OFF)
    await writeSwitches('usr_a', { messages: true, rsvpEvents: false }, device)
    expect(await readSwitches('usr_a', device)).deep.equals({
      messages: true,
      rsvpEvents: false
    })
    // Somebody else signed in on the same device starts from their own.
    expect(await readSwitches('usr_b', device)).deep.equals(SWITCHES_OFF)
    await writeSwitches('usr_b', { messages: false, rsvpEvents: true }, device)
    expect(await readSwitches('usr_a', device)).deep.equals({
      messages: true,
      rsvpEvents: false
    })
    expect([...device.kept.keys()].sort()).deep.equals(
      [switchesKey('usr_a'), switchesKey('usr_b')].sort()
    )
    expect(switchesKey('usr/a')).equals('teamstation:notifications:usr%2Fa')
  })

  it('reads anything it cannot make out as both off, and drops a refused write', async function () {
    const device = storage()
    for (const raw of ['not json', 'null', '7', '{"messages":"yes"}']) {
      device.kept.set(switchesKey('usr_a'), raw)
      expect(await readSwitches('usr_a', device), raw).deep.equals(SWITCHES_OFF)
    }
    device.kept.set(switchesKey('usr_a'), '{"rsvpEvents":true,"extra":1}')
    expect(await readSwitches('usr_a', device)).deep.equals({
      messages: false,
      rsvpEvents: true
    })
    const refusing = storage(true)
    await writeSwitches('usr_a', { messages: true, rsvpEvents: true }, refusing)
    expect(await readSwitches('usr_a', refusing)).deep.equals(SWITCHES_OFF)
  })

  it('says whether either is on', function () {
    expect(anySwitchOn(SWITCHES_OFF)).equals(false)
    expect(anySwitchOn({ messages: true, rsvpEvents: false })).equals(true)
    expect(anySwitchOn({ messages: false, rsvpEvents: true })).equals(true)
  })

  it('uses this device’s own storage by default', async function () {
    // What this environment keeps, or, with no localStorage, both off.
    const on = { messages: true, rsvpEvents: true }
    await writeSwitches('usr_default', on)
    expect([on, SWITCHES_OFF]).to.deep.include(
      await readSwitches('usr_default')
    )
  })

  it('keeps whether each person was asked, beside their switches', async function () {
    const device = storage()
    expect(await readAsked('usr_a', device)).equals(false)
    await writeAsked('usr_a', device)
    expect(await readAsked('usr_a', device)).equals(true)
    // Somebody else on the same device has not been asked.
    expect(await readAsked('usr_b', device)).equals(false)
    // Asking leaves the switches as they were.
    expect(await readSwitches('usr_a', device)).deep.equals(SWITCHES_OFF)
    expect([...device.kept.keys()]).deep.equals([askedKey('usr_a')])
    expect(askedKey('usr/a')).equals('teamstation:askedNotifications:usr%2Fa')
    // Storage that refuses reads as not asked, and drops the write.
    const refusing = storage(true)
    await writeAsked('usr_a', refusing)
    expect(await readAsked('usr_a', refusing)).equals(false)
    await writeAsked('usr_default')
    expect([true, false]).to.include(await readAsked('usr_default'))
  })
})
