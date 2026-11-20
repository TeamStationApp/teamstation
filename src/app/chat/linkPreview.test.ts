import { expect } from 'chai'

import { chatLinkSpans } from './chatMessageLinks'
import {
  firstPreviewUrl,
  pageMetadata,
  previewDestination
} from './linkPreview'
import { rasterDimensions } from './previewImage'

describe('chat link preview', () => {
  it('selects the same full destination a person can open', () => {
    for (const [body, link] of [
      ['🔗https://example.org/directions', 'https://example.org/directions'],
      ['🔗www.example.org/teams', 'www.example.org/teams'],
      ['See (🔗www.example.org/team)', 'www.example.org/team'],
      ['See (🔗https://example.org/team)', 'https://example.org/team'],
      [
        'https://example.org/p(🔗www.example.net/hi)',
        'https://example.org/p(🔗www.example.net/hi)'
      ],
      ['See “🔗https://example.org/news”', 'https://example.org/news'],
      ['[🔗www.example.org/teams]', 'www.example.org/teams'],
      [
        'https://example.org/wiki/2024–25_NBA_season',
        'https://example.org/wiki/2024–25_NBA_season'
      ]
    ]) {
      const start = body.indexOf(link)
      expect(chatLinkSpans(body)).deep.equals([
        { text: link, start, end: start + link.length }
      ])
      expect(firstPreviewUrl(body)).equals(
        new URL(link.startsWith('www.') ? 'https://' + link : link).href
      )
    }
    for (const link of [
      'https://example.org/?q=www.example.com%2Fnews',
      'https://example.org/www.example.com%2Fnews'
    ]) {
      expect(chatLinkSpans(link).map(span => span.text)).deep.equals([link])
      expect(firstPreviewUrl(link)).equals(link)
    }
    expect(
      firstPreviewUrl(
        '"see https://example.org"@example.net then wikipedia.org'
      )
    ).equals('https://wikipedia.org/')
    expect(chatLinkSpans('www.exa%6Dple.org/doc')).deep.equals([])
    expect(
      firstPreviewUrl(
        'me@example.org document.pdf then example.com and example.net'
      )
    ).equals('https://example.com/')
    expect(
      firstPreviewUrl('www.exa%6Dple.org/doc then https://example.org/ok')
    ).equals(undefined)
    expect(firstPreviewUrl('https:// then example.org')).equals(undefined)
    expect(firstPreviewUrl('https://localhost/data then example.org')).equals(
      undefined
    )
  })
  it('falls back when a preferred field contains only control characters', () => {
    expect(
      pageMetadata(
        '<title>Saturday Schedule</title><meta property="og:title" content="&#x7f;"><meta property="og:site_name" content="&#x7f;"><meta property="og:description" content="&#x7f;"><meta name="description" content="Next game">',
        'https://example.org/'
      )
    ).deep.equals({
      url: 'https://example.org/',
      title: 'Saturday Schedule',
      description: 'Next game',
      siteName: 'example.org'
    })
  })
  it('checks destinations independently for the page and thumbnail', () => {
    const origins = {
      active: 'https://seat.example.com',
      verified: 'https://build.example.net'
    }
    for (const base of Object.values(origins)) {
      expect(
        firstPreviewUrl(base + '/team and https://example.org', origins)
      ).equals(undefined)
      expect(
        pageMetadata(
          '<title>Team</title><meta property="og:image" content="' +
            base +
            '/photo">',
          'https://example.org/',
          origins
        )?.imageUrl
      ).equals(undefined)
    }
    for (const url of [
      'http://127.0.0.1',
      'https://[::1]',
      'http://192.168.2.3',
      'http://[::ffff:127.0.0.1]',
      'http://printer.local',
      'https://files.home.arpa',
      'https://app.teamstation.app',
      'https://name:secret@example.com',
      'file:///document',
      'not a URL'
    ])
      expect(previewDestination(url)).equals(undefined)
    expect(previewDestination('https://example.org/team#about')).equals(
      'https://example.org/team'
    )
    expect(
      previewDestination('https://example.org/team', 'https://example.org')
    ).equals(undefined)
  })
  it('extracts inert, bounded metadata and ignores markup, base and body', () => {
    const url = 'https://example.org/pages/post'
    const page =
      '<head><base href="https://example.net/"><title>Fallback &amp; title</title><meta property="og:title" content="  League &amp; Team  "><meta name="description" content="Next\n game"><meta property="og:site_name" content="Sports"><meta property="og:image" content="img.png"><script>ignored()</script></head><body>Not page details</body>'
    expect(pageMetadata(page, url)).deep.equals({
      url,
      title: 'League & Team',
      description: 'Next game',
      siteName: 'Sports',
      imageUrl: 'https://example.org/pages/img.png'
    })
    const fallback = pageMetadata(
      '<title>Fallback</title><meta property="og:image" content="http://localhost/img">',
      url
    )
    expect(fallback).deep.equals({
      url,
      title: 'Fallback',
      description: '',
      siteName: 'example.org'
    })
    expect(pageMetadata('<body>Hi</body>', url)).equals(undefined)
    expect(
      Array.from(
        pageMetadata('<title>' + '⚾'.repeat(300) + '</title>', url)!.title
      )
    ).to.have.length(256)
  })
  it('checks image dimensions before decoding', () => {
    const png = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16,
      0, 0, 0, 8
    ])
    expect(rasterDimensions(png)).deep.equals({
      width: 16,
      height: 8,
      mime: 'image/png'
    })
    const large = png.slice()
    large[16] = 1
    for (const invalid of [
      large,
      png.slice(0, 20),
      Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 0)
    ])
      expect(rasterDimensions(invalid)).equals(undefined)
  })

  it('reads the dimensions of lossy, lossless and extended WebP headers', () => {
    const images = [
      'UklGRiwAAABXRUJQVlA4ICAAAACQAQCdASoDAAIAAgA0JaQAAudZtgAA/v5Z19kzzwgAAA==',
      'UklGRjgAAABXRUJQVlA4TCsAAAAvAkAAAC9AkG2z7f7Ul1AIIAAKGoUAAqCgmf+U7h1q2jZgQ51/OTWi/zG9AA==',
      'UklGRk4AAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAAwcLDxMXAFZQOCAgAAAAkAEAnQEqAwACAAIANCWkAALnRawAAP7+J/fhlrwIAAA='
    ].map(value => Buffer.from(value, 'base64'))
    for (const bytes of images) {
      expect(rasterDimensions(bytes)).deep.equals({
        width: 3,
        height: 2,
        mime: 'image/webp'
      })
    }
    const animated = Buffer.from(images[2])
    animated[20] |= 2
    expect(rasterDimensions(animated)).equals(undefined)
  })
})
