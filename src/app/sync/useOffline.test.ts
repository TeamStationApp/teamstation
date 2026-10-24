import { expect } from 'chai'

import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import {
  DEAD_GAME_FALLBACK,
  editCount,
  heldGameText,
  OFFLINE_BANNER,
  offlineBannerText,
  offlineCreateFailure,
  PARKED_GAME_MESSAGE
} from './useOffline'

const queue = (
  count: number,
  held: 'game' | 'team' | undefined = undefined
): Parameters<typeof offlineBannerText>[1] => ({
  count,
  chains: {},
  games: held === 'game' ? { g1: { state: 'parked', message: 'stale' } } : {},
  teams: held === 'team' ? { t1: { state: 'dead', message: 'No' } } : {}
})

describe('what the phone says offline', function () {
  it('counts edits', function () {
    expect(editCount(1)).equals('1 edit')
    expect(editCount(2)).equals('2 edits')
  })

  it('puts the waiting count on the offline banner, and says nothing once the queue is empty online', function () {
    expect(offlineBannerText(true, undefined)).equals(OFFLINE_BANNER)
    expect(offlineBannerText(true, queue(0))).equals(OFFLINE_BANNER)
    expect(offlineBannerText(true, queue(2))).equals(
      `${OFFLINE_BANNER} · 2 edits waiting`
    )
    expect(offlineBannerText(false, undefined)).equals(undefined)
    expect(offlineBannerText(false, queue(0))).equals(undefined)
    expect(offlineBannerText(false, queue(1))).equals('Sending 1 edit…')
    expect(offlineBannerText(false, queue(3, 'game'))).equals(
      '3 edits not sent'
    )
    expect(offlineBannerText(false, queue(1, 'team'))).equals('1 edit not sent')
  })

  it("says a parked game's server copy changed, and a refused one in the server's words", function () {
    expect(heldGameText(undefined)).equals(undefined)
    expect(heldGameText({ state: 'parked', message: 'stale' })).equals(
      PARKED_GAME_MESSAGE
    )
    expect(
      heldGameText({ state: 'dead', message: 'That inning is closed.' })
    ).equals('Not sent: That inning is closed.')
    expect(heldGameText({ state: 'dead', message: null })).equals(
      `Not sent: ${DEAD_GAME_FALLBACK}`
    )
  })

  it("gives a create's form the offline sentence on the phone only", function () {
    const offline = new HttpError('offline', 'Cannot reach TeamStation.')
    const phone = new CachingClient({
      baseUrl: 'http://x/api/v1',
      openCache: async () => {
        throw new Error('no file')
      }
    })
    const web = new TeamStationClient({ baseUrl: 'http://x/api/v1' })
    expect(offlineCreateFailure(phone, offline)).equals(OFFLINE_CREATE_MESSAGE)
    expect(offlineCreateFailure(web, offline)).equals(undefined)
    expect(
      offlineCreateFailure(phone, new HttpError('conflict', 'Taken'))
    ).equals(undefined)
    expect(offlineCreateFailure(phone, new Error('x'))).equals(undefined)
  })

  it('tells each change of offline once, until unsubscribed', function () {
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1' })
    const heard: boolean[] = []
    const stop = client.subscribeOffline(value => heard.push(value))
    client.offline = true
    client.offline = true
    client.offline = false
    stop()
    client.offline = true
    expect(heard).deep.equals([true, false])
    expect(client.offline).equals(true)
  })
})
