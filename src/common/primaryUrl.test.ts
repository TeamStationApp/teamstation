import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import path from 'path'

import {
  asAuthority,
  hostOf,
  httpOrigin,
  isPlainHttp,
  PRIMARY_HOST,
  rtmpOrigin
} from './primaryUrl'

describe('the primary address', function () {
  it('is a host and nothing else', function () {
    // The whole point: no scheme is written down anywhere, so nothing can
    // disagree with anything else about what the scheme is.
    expect(PRIMARY_HOST).does.not.contain('://')
    expect(PRIMARY_HOST).does.not.contain('/')
  })

  it('is the same name the Swift apps were built with', function () {
    // The name is written down twice, because Swift cannot import this file.
    // Two literals with a test between them, rather than the committed
    // `config.json` both used to read: the file was one copy, but a branch
    // that wanted a development server had to edit it, and editing it is how
    // the address went stale on a Director in the first place.
    const swift = readFileSync(
      path.join(
        __dirname,
        '../../mobile/apps/common/GameStationKit/Sources/GameStationKit/AppServer.swift'
      ),
      'utf8'
    )
    const written = /defaultHost = "([^"]+)"/.exec(swift)
    expect(written?.[1]).equals(PRIMARY_HOST)
  })

  it('takes an address however somebody wrote it', function () {
    expect(asAuthority('develop2.teamstation.app')).equals(
      'develop2.teamstation.app'
    )
    expect(asAuthority('https://develop2.teamstation.app/')).equals(
      'develop2.teamstation.app'
    )
    expect(asAuthority('  http://127.0.0.1:9100/api/v1  ')).equals(
      '127.0.0.1:9100'
    )
    expect(asAuthority('')).equals('')
  })

  it('separates the host from the port', function () {
    expect(hostOf('app.teamstation.app')).equals('app.teamstation.app')
    expect(hostOf('127.0.0.1:9100')).equals('127.0.0.1')
    expect(hostOf('[::1]:9100')).equals('[::1]')
  })

  it('implies https for a name and http for an address', function () {
    expect(isPlainHttp('app.teamstation.app')).equals(false)
    expect(isPlainHttp('develop2.teamstation.app')).equals(false)
    expect(isPlainHttp('localhost:8080')).equals(true)
    expect(isPlainHttp('127.0.0.1:9100')).equals(true)
    expect(isPlainHttp('10.10.7.181')).equals(true)
    expect(isPlainHttp('[::1]:9100')).equals(true)
  })

  it('builds the origin the app is served from', function () {
    expect(httpOrigin(PRIMARY_HOST)).equals('https://app.teamstation.app')
    expect(httpOrigin('develop2.teamstation.app')).equals(
      'https://develop2.teamstation.app'
    )
    // Nobody holds a certificate for a loopback address, and this is the one
    // case a person actually meets: a server they are running themselves.
    expect(httpOrigin('127.0.0.1:9100')).equals('http://127.0.0.1:9100')
    expect(httpOrigin('localhost:8080')).equals('http://localhost:8080')
  })

  it('builds the stream URL on the ingest port, not the web one', function () {
    expect(rtmpOrigin(PRIMARY_HOST, 1936)).equals(
      'rtmp://app.teamstation.app:1936'
    )
    // The override carries the *web* port where it carries one at all, and
    // the ingest is listening somewhere else entirely.
    expect(rtmpOrigin('127.0.0.1:9100', 1936)).equals('rtmp://127.0.0.1:1936')
  })

  it('leaves rtmp unencrypted wherever it points', function () {
    // There is no rtmps here to choose between, so an IP and a DNS name both
    // get the same scheme — unlike the web origin above.
    expect(
      rtmpOrigin('app.teamstation.app', 1936).startsWith('rtmp://')
    ).equals(true)
    expect(rtmpOrigin('127.0.0.1', 1936).startsWith('rtmp://')).equals(true)
  })
})
