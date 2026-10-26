import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

import { tsBallpark } from '../theme/tsBallpark'
import { RICH_POLICY, richColorsOf, richDocument } from './richDocument'

const colors = richColorsOf(tsBallpark)

function parse(html: string): Document {
  return new JSDOM(richDocument(html, colors)).window.document
}

/**
 * JSDOM enforces no policy, so this checks the document's shape: the browser
 * and the phone are where the policy is seen to stop a request.
 */
describe('richDocument', function () {
  it('makes the policy the first element of the head, with exactly the policy', function () {
    expect(RICH_POLICY).equals(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    )
    const document = parse('<table><tr><td>1</td></tr></table>')
    const first = document.head.firstElementChild!
    expect(first.tagName).equals('META')
    expect(first.getAttribute('http-equiv')).equals('Content-Security-Policy')
    expect(first.getAttribute('content')).equals(RICH_POLICY)
    expect(document.body.querySelector('td')?.textContent).equals('1')
  })

  it('keeps the policy first when the HTML opens its own head or meta', function () {
    const document = parse(
      '</head><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>' +
        '<meta http-equiv="refresh" content="0;url=https://example.com"><svg></svg>'
    )
    const policies = [
      ...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    ]
    expect(policies[0]).equals(document.head.firstElementChild)
    expect(policies[0].getAttribute('content')).equals(RICH_POLICY)
    expect(policies.length).equals(1)
    expect(document.querySelector('meta[http-equiv="refresh"]')).equals(null)
    expect(document.querySelector('svg')).not.equals(null)
  })

  it('drops the markup the policy cannot govern, and sends links nowhere', function () {
    const document = parse(
      '<link rel="dns-prefetch" href="https://example.com"><base href="https://example.com/">' +
        '<META HTTP-EQUIV="refresh" CONTENT="0"><a href="https://example.com">x</a>'
    )
    expect(document.querySelectorAll('link').length).equals(0)
    expect(document.querySelectorAll('meta').length).equals(3)
    const bases = [...document.querySelectorAll('base')]
    expect(bases.length).equals(1)
    expect(bases[0].getAttribute('href')).equals(null)
    expect(bases[0].getAttribute('target')).equals('_blank')
    expect(document.querySelector('a')?.textContent).equals('x')
  })

  it('leaves no meta, link or base for nested markup to close up into', function () {
    for (const html of [
      '<li<link>nk rel="preconnect" href="https://x-secret.example.com">',
      '<lin<link rel="x">k rel="dns-prefetch" href="https://example.com">',
      '<me<meta>ta http-equiv="refresh" content="0;url=https://example.com">',
      '<ba<base>se href="https://example.com/">',
      '<<link>link href="https://example.com">',
      '<LINK\nrel="preconnect" href="https://example.com"><link/href="https://example.com">',
      '</link><meta/http-equiv="refresh" content="0">'
    ]) {
      const document = parse(html)
      expect(document.querySelectorAll('link').length, html).equals(0)
      expect(document.querySelector('meta[http-equiv="refresh"]'), html).equals(
        null
      )
      expect(document.querySelectorAll('meta').length, html).equals(3)
      const bases = [...document.querySelectorAll('base')]
      expect(bases.length, html).equals(1)
      expect(bases[0].getAttribute('href'), html).equals(null)
    }
    // What is left reads as text, and other markup is untouched.
    const document = parse(
      '<p>a <link> b</p><table><tr><td>1</td></tr></table>'
    )
    expect(document.querySelector('p')?.textContent).equals('a <link> b')
    expect(document.querySelector('td')?.textContent).equals('1')
  })

  it('draws in the theme with system fonts only', function () {
    const source = richDocument('<p>hi</p>', colors)
    expect(source).includes(`color:${tsBallpark.primaryTextColor}`)
    expect(source).includes(`background:${tsBallpark.cardBackgroundColor}`)
    expect(source).not.includes('url(')
    expect(source).not.includes('@import')
  })
})
