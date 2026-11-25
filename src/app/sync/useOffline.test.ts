import { expect } from 'chai'

import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import { EDITS_PLACE } from './editsPlace'
import {
  DEAD_GAME_FALLBACK,
  editCount,
  heldEditKey,
  heldEditRetries,
  heldEdits,
  heldEditText,
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

  it('lists every held game, then every held team, each in id order', function () {
    expect(heldEdits(undefined)).deep.equals([])
    expect(heldEdits(queue(0))).deep.equals([])
    const dead = { state: 'dead' as const, message: 'No' }
    const listed = heldEdits({
      count: 4,
      chains: {},
      games: { g2: dead, g1: { state: 'parked', message: 'stale' } },
      teams: { t9: dead, t1: dead }
    })
    expect(listed.map(heldEditKey)).deep.equals([
      'game:g1',
      'game:g2',
      'team:t1',
      'team:t9'
    ])
  })

  it('offers Try Again for every held game, and for a team only once refused', function () {
    const held = (
      state: 'dead' | 'parked'
    ): { state: 'dead' | 'parked'; message: null } => ({ state, message: null })
    expect(
      heldEditRetries({ kind: 'game', id: 'g1', held: held('dead') })
    ).equals(true)
    expect(
      heldEditRetries({ kind: 'game', id: 'g1', held: held('parked') })
    ).equals(true)
    expect(
      heldEditRetries({ kind: 'team', id: 't1', held: held('dead') })
    ).equals(true)
    expect(
      heldEditRetries({ kind: 'team', id: 't1', held: held('parked') })
    ).equals(false)
  })

  it("says what each held queue is in the server's words", function () {
    const game = (held: Parameters<typeof heldGameText>[0]): string =>
      heldEditText({ kind: 'game', id: 'g1', held: held! })
    expect(game({ state: 'dead', message: 'That inning is closed.' })).equals(
      'Not sent: That inning is closed.'
    )
    expect(game({ state: 'parked', message: 'stale' })).equals(
      PARKED_GAME_MESSAGE
    )
    expect(
      game({ state: 'parked', message: 'Only staff', cause: 'player' })
    ).equals('Not sent: Only staff')
    const team = (message: string | null): string =>
      heldEditText({ kind: 'team', id: 't1', held: { state: 'dead', message } })
    expect(team('Only staff')).equals(
      `A player added ${EDITS_PLACE.on} was not saved: Only staff`
    )
    expect(team(null)).equals(
      `A player added ${EDITS_PLACE.on} was not saved: ${DEAD_GAME_FALLBACK}`
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
