import { expect } from 'chai'

import {
  chatLinkAddress,
  chatLinkRoute,
  chatLinkSpans
} from './chatMessageLinks'

describe('chat message links', () => {
  const texts = (body: string): string[] =>
    chatLinkSpans(body).map(span => {
      expect(body.slice(span.start, span.end)).equals(span.text)
      return span.text
    })

  it('preserves offsets, punctuation, long paths and multiple visible destinations', () => {
    const full = 'https://example.org/wiki/A_(B)?x=1#top'
    const body =
      '⚾ See (' +
      full +
      '), then www.example.com:8443/a and\nteamstation.app/x.'
    expect(texts(body)).deep.equals([
      full,
      'www.example.com:8443/a',
      'teamstation.app/x'
    ])
    expect(chatLinkAddress(full)?.href).equals(full)
    expect(chatLinkAddress('www.example.com:8443/a')?.href).equals(
      'https://www.example.com:8443/a'
    )
    expect(chatLinkAddress('teamstation.app/x')?.href).equals(
      'https://teamstation.app/x'
    )
    expect(texts('http://example.test/x https://example.org')).deep.equals([
      'http://example.test/x',
      'https://example.org'
    ])
  })

  it('keeps punctuation outside bare addresses with a port', () => {
    expect(
      texts('Read (example.org:8443), then example.com:8080.')
    ).deep.equals(['example.org:8443', 'example.com:8080'])
    expect(texts('“Example.org:443/a”')).deep.equals(['Example.org:443/a'])
    expect(texts('123.example.org:8080 / café.example.org:8443.')).deep.equals([
      '123.example.org:8080',
      'café.example.org:8443'
    ])
    expect(texts('example.org:99999.')).deep.equals([])
  })

  it('leaves files, decimal numbers, mail, other schemes and ambiguous text alone', () => {
    for (const body of [
      '2.50 notes.pdf video.MOV archive.zip',
      'me@example.org',
      'tel:example.org',
      'javascript:https://example.org',
      'ftp://example.org/x',
      'data:text/plain,https://example.org',
      '//www.example.org',
      'https://user@example.org',
      'https://example.org\\@example.net',
      'https://example.org/\u202Ename',
      'plain text',
      'x'.repeat(17000) + '.com'
    ])
      expect(texts(body), body.slice(0, 40)).deep.equals([])
    expect(texts('www.example.zip https://example.mov/doc.pdf')).deep.equals([
      'www.example.zip',
      'https://example.mov/doc.pdf'
    ])
    expect(texts('Release 1.20.5 and https://example.net/end')).deep.equals([
      'https://example.net/end'
    ])
  })

  it('checks the URL again at activation', () => {
    for (const value of [
      '',
      'no domain',
      'file:///tmp/test.pdf',
      'https:///x',
      'https://@x.com',
      'https://example.org:99999',
      'javascript:window.x',
      'https://u:p@example.org',
      'https://example.org/\u0000',
      'https://example.org\\path'
    ])
      expect(chatLinkAddress(value), value).equals(undefined)
    expect(chatLinkAddress('HTTP://EXAMPLE.ORG/a?b=1#c')?.href).equals(
      'http://example.org/a?b=1#c'
    )
  })

  const origin = 'https://app.example.test'
  const active = 'https://seat.example.test'
  const route = (url: string): ReturnType<typeof chatLinkRoute> =>
    chatLinkRoute(new URL(url), active, origin)
  it('routes exact application hosts and preserves aliases and the active deployment', () => {
    expect(route(active + '/schedule?when=past')).deep.equals({
      name: 'schedule',
      when: 'past'
    })
    expect(route(origin + '/')).deep.equals({ name: 'home' })
    for (const host of [
      'app.teamstation.app',
      'web.teamstation.app',
      'teamstation.app'
    ]) {
      expect(route('https://' + host + '/i/sample')).deep.equals({
        name: 'join',
        code: 'sample'
      })
    }
    expect(route(active + '/c/invite/sample')).deep.equals({
      name: 'join',
      code: 'sample'
    })
    expect(route(active + '/video-channels/invite/sample/')).deep.equals({
      name: 'join',
      code: 'sample'
    })
    expect(route(active + '/games/demo?tab=score')).deep.equals({
      name: 'scoreOptions',
      gameId: 'demo'
    })
  })
  it('keeps unknown paths, lookalikes, other ports and malformed paths out of the router', () => {
    for (const url of [
      active + '/unrecognized',
      active + '/games/demo/unrecognized',
      active + '/schedule/unrecognized',
      'https://app.teamstation.app.example.com/schedule',
      'https://app.teamstation.app:123/schedule',
      active + '/venues/%ZZ'
    ])
      expect(route(url), url).equals(undefined)
  })
  it('honors the verified origin for sign-in and TV links', () => {
    expect(
      chatLinkRoute(
        new URL('http://app.example.test/signin/code'),
        'http://app.example.test',
        origin
      )
    ).deep.equals({ name: 'signIn' })
    expect(route(active + '/signin/code')).deep.equals({ name: 'signIn' })
    expect(route(origin + '/signin/code')?.name).equals('signInLink')
    const path = '/tv-login?token=' + 'a'.repeat(43)
    expect(route(active + path)).deep.equals({ name: 'teamStationTv' })
    expect(route(origin + path)).deep.equals({
      name: 'teamStationTv',
      token: 'a'.repeat(43)
    })
  })
})
