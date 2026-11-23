import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ALL_ON,
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
  it('starts all three off, and keeps each person’s apart', async function () {
    const device = storage()
    expect(await readSwitches('usr_a', device)).deep.equals(SWITCHES_OFF)
    expect(SWITCHES_OFF).deep.equals({
      messages: false,
      rsvpEvents: false,
      leagueManagement: false
    })
    const a = { messages: true, rsvpEvents: false, leagueManagement: false }
    await writeSwitches('usr_a', a, device)
    expect(await readSwitches('usr_a', device)).deep.equals(a)
    expect(device.kept.get(switchesKey('usr_a'))).equals(
      '{"messages":true,"rsvpEvents":false,"leagueManagement":false}'
    )
    // Somebody else signed in on the same device starts from their own.
    expect(await readSwitches('usr_b', device)).deep.equals(SWITCHES_OFF)
    await writeSwitches(
      'usr_b',
      { messages: false, rsvpEvents: true, leagueManagement: true },
      device
    )
    expect(await readSwitches('usr_a', device)).deep.equals(a)
    expect(await readSwitches('usr_b', device)).deep.equals({
      messages: false,
      rsvpEvents: true,
      leagueManagement: true
    })
    expect([...device.kept.keys()].sort()).deep.equals(
      [switchesKey('usr_a'), switchesKey('usr_b')].sort()
    )
    expect(switchesKey('usr/a')).equals('teamstation:notifications:usr%2Fa')
  })

  it('reads anything it cannot make out as all off, and drops a refused write', async function () {
    const device = storage()
    for (const raw of ['not json', 'null', '7']) {
      device.kept.set(switchesKey('usr_a'), raw)
      expect(await readSwitches('usr_a', device), raw).deep.equals(SWITCHES_OFF)
    }
    device.kept.set(
      switchesKey('usr_a'),
      '{"messages":"yes","rsvpEvents":true,"leagueManagement":"yes","extra":1}'
    )
    expect(await readSwitches('usr_a', device)).deep.equals({
      messages: false,
      rsvpEvents: true,
      leagueManagement: false
    })
    const refusing = storage(true)
    await writeSwitches('usr_a', ALL_ON, refusing)
    expect(await readSwitches('usr_a', refusing)).deep.equals(SWITCHES_OFF)
  })

  it('reads League management on in a set an earlier build kept while either of the other two is on, and off with both off', async function () {
    const device = storage()
    for (const [raw, messages, rsvpEvents, leagueManagement] of [
      ['{"messages":true,"rsvpEvents":true}', true, true, true],
      ['{"messages":true,"rsvpEvents":false}', true, false, true],
      ['{"messages":false,"rsvpEvents":true}', false, true, true],
      ['{"messages":false,"rsvpEvents":false}', false, false, false],
      ['{}', false, false, false]
    ] as const) {
      device.kept.set(switchesKey('usr_a'), raw)
      expect(await readSwitches('usr_a', device), raw).deep.equals({
        messages,
        rsvpEvents,
        leagueManagement
      })
    }
    // Kept on with the other two off, it stays on.
    device.kept.set(
      switchesKey('usr_a'),
      '{"messages":false,"rsvpEvents":false,"leagueManagement":true}'
    )
    expect((await readSwitches('usr_a', device)).leagueManagement).equals(true)
    // Turned off and kept, it stays off.
    device.kept.set(
      switchesKey('usr_a'),
      '{"messages":true,"rsvpEvents":true,"leagueManagement":false}'
    )
    expect((await readSwitches('usr_a', device)).leagueManagement).equals(false)
  })

  it('says whether any is on', function () {
    expect(anySwitchOn(SWITCHES_OFF)).equals(false)
    expect(anySwitchOn({ ...SWITCHES_OFF, messages: true })).equals(true)
    expect(anySwitchOn({ ...SWITCHES_OFF, rsvpEvents: true })).equals(true)
    expect(anySwitchOn({ ...SWITCHES_OFF, leagueManagement: true })).equals(
      true
    )
    expect(anySwitchOn(ALL_ON)).equals(true)
  })

  it('uses this device’s own storage by default', async function () {
    // What this environment keeps, or, with no localStorage, all off.
    const on = ALL_ON
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
