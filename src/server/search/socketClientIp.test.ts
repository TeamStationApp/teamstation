import type { IncomingMessage } from 'node:http'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { upgradeClientIp } from './socket'

const upgrade = (
  remoteAddress: string | undefined,
  forwarded?: string | string[]
): IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers: forwarded == null ? {} : { 'x-forwarded-for': forwarded }
  }) as unknown as IncomingMessage

describe('the search socket’s client address', () => {
  it('is the socket’s own address when no proxy on this machine sent it', () => {
    expect(upgradeClientIp(upgrade('203.0.113.7'))).equals('203.0.113.7')
    // A client cannot name itself through the header.
    expect(upgradeClientIp(upgrade('203.0.113.7', '198.51.100.1'))).equals(
      '203.0.113.7'
    )
    expect(upgradeClientIp(upgrade('::ffff:203.0.113.7'))).equals('203.0.113.7')
    expect(upgradeClientIp(upgrade('2001:db8::7'))).equals('2001:db8::7')
  })

  it('is the right-most forwarded address the local proxy did not add', () => {
    expect(upgradeClientIp(upgrade('127.0.0.1', '203.0.113.7'))).equals(
      '203.0.113.7'
    )
    expect(
      upgradeClientIp(upgrade('::1', '198.51.100.1, 203.0.113.7, 127.0.0.1'))
    ).equals('203.0.113.7')
    expect(
      upgradeClientIp(
        upgrade('::ffff:127.0.0.1', ['198.51.100.1', '::ffff:203.0.113.7'])
      )
    ).equals('203.0.113.7')
  })

  it('is the loopback address with nothing forwarded past it, and null with no socket address', () => {
    expect(upgradeClientIp(upgrade('127.0.0.1'))).equals('127.0.0.1')
    expect(upgradeClientIp(upgrade('127.0.0.1', '127.0.0.1, ::1'))).equals(
      '127.0.0.1'
    )
    expect(upgradeClientIp(upgrade('127.0.0.1', ' , '))).equals('127.0.0.1')
    expect(upgradeClientIp(upgrade(undefined))).equals(null)
  })
})
