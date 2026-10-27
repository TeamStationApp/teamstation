import { expect } from 'chai'
import { describe, it } from 'mocha'

import { OFFLINE_BANNER } from '../sync/useOffline'
import { nextReconnect, scoringStatusLine } from './scoringStatusLine'

const saved = { pending: 0, offline: false, readOnly: false, problem: null }
const line = (
  input: Partial<Parameters<typeof scoringStatusLine>[0]>
): ReturnType<typeof scoringStatusLine> =>
  scoringStatusLine({
    status: saved,
    phoneOffline: false,
    reconnecting: false,
    ...input
  })

describe('the scoring status line', function () {
  it('says nothing for a tap whose save is on its way', function () {
    expect(line({})).equals(null)
    expect(line({ status: { ...saved, pending: 2 } })).equals(null)
  })

  it('puts the phone’s offline line at the top', function () {
    expect(line({ phoneOffline: true })).deep.equals({
      text: OFFLINE_BANNER,
      place: 'top'
    })
    expect(
      line({ phoneOffline: true, status: { ...saved, pending: 1 } })
    ).deep.equals({ text: OFFLINE_BANNER, place: 'top' })
  })

  it('puts a web session’s offline count at the top', function () {
    expect(
      line({ status: { ...saved, pending: 1, offline: true } })
    ).deep.equals({ text: 'Offline — 1 play waiting', place: 'top' })
    expect(
      line({ status: { ...saved, pending: 3, offline: true } })?.text
    ).equals('Offline — 3 plays waiting')
  })

  it('says nothing of a web session offline with nothing waiting, as an undone play leaves it', function () {
    expect(line({ status: { ...saved, pending: 0, offline: true } })).equals(
      null
    )
  })

  it('says Saving… only while what waited offline goes out', function () {
    expect(line({ reconnecting: true })).deep.equals({
      text: 'Saving…',
      place: 'save'
    })
  })

  it('still says why a save failed, over being offline', function () {
    expect(
      line({
        phoneOffline: true,
        status: { ...saved, pending: 1, problem: 'play 0: bad' }
      })
    ).deep.equals({ text: 'Not saved: play 0: bad', place: 'save' })
  })

  it('gives a held game’s line first, and nothing when read-only', function () {
    expect(
      line({
        held: 'Not sent: refused',
        phoneOffline: true,
        status: { ...saved, readOnly: true }
      })
    ).deep.equals({ text: 'Not sent: refused', place: 'save' })
    expect(
      line({ status: { ...saved, readOnly: true, problem: 'No' } })
    ).equals(null)
    expect(
      line({ phoneOffline: true, status: { ...saved, readOnly: true } })
    ).equals(null)
  })
})

describe('the reconnect latch', function () {
  it('turns on offline, holds while busy back online, and clears when idle', function () {
    expect(nextReconnect(false, false, true)).equals(false)
    expect(nextReconnect(false, true, false)).equals(true)
    expect(nextReconnect(true, true, true)).equals(true)
    expect(nextReconnect(true, false, true)).equals(true)
    expect(nextReconnect(true, false, false)).equals(false)
    expect(nextReconnect(false, false, false)).equals(false)
  })
})
