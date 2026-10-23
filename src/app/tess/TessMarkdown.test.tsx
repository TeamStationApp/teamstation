/* eslint-disable @typescript-eslint/unbound-method -- The test swaps Linking.openURL and puts it back. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Linking } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  render,
  unmount
} from '../../test/tessTestKit'
import { decodeEntities, linkTarget, TessMarkdown } from './TessMarkdown'
import { waySegments } from './WayBubble'

const openURL = Linking.openURL

async function show(
  text: string,
  navigated: string[] = []
): Promise<HTMLElement> {
  return await render(
    <TessMarkdown text={text} onNavigate={path => navigated.push(path)} />
  )
}

function linkNamed(host: HTMLElement, words: string): HTMLElement {
  const link = [...host.querySelectorAll<HTMLElement>('[role="link"]')].find(
    node => node.textContent === words
  )
  expect(link, words).not.equals(undefined)
  return link!
}

describe('TessMarkdown', function () {
  afterEach(async () => {
    await unmount()
    Linking.openURL = openURL
  })

  it('draws headings, paragraphs, emphasis, lists, quotes, rules and code', async function () {
    const host = await show(
      [
        '# Standings',
        '## This week',
        '### Notes',
        'Plain, **bold**, *italic*, ~~gone~~ and `inline code` &amp; more.',
        '- first',
        '- second',
        '',
        '3. third',
        '4. fourth',
        '',
        '> Quoted words',
        '',
        '---',
        '',
        '```',
        'const answer = 42',
        '```'
      ].join('\n')
    )
    const headings = [...host.querySelectorAll('[role="heading"]')].map(
      node => node.textContent
    )
    expect(headings).deep.equals(['Standings', 'This week', 'Notes'])
    const text = host.textContent ?? ''
    expect(text).includes('Plain, bold, italic, gone and inline code & more.')
    expect(text).includes('•first')
    expect(text).includes('•second')
    expect(text).includes('3.third')
    expect(text).includes('4.fourth')
    expect(text).includes('Quoted words')
    expect(text).includes('const answer = 42')
    const bold = [...host.querySelectorAll<HTMLElement>('div, span')].find(
      node => node.textContent === 'bold'
    )!
    expect(getComputedStyle(bold).fontWeight).equals('700')
    const italic = [...host.querySelectorAll<HTMLElement>('div, span')].find(
      node => node.textContent === 'italic'
    )!
    expect(getComputedStyle(italic).fontStyle).equals('italic')
    expect(host.querySelector('[data-testid="Tess rich block"]')).equals(null)
  })

  it('navigates in the app for an app path and opens https outside it', async function () {
    const opened: string[] = []
    Linking.openURL = async url => {
      opened.push(url)
    }
    const navigated: string[] = []
    const host = await show(
      'See [Comets](/teams/t1) or [the rules](https://example.com/rules).',
      navigated
    )
    await click(linkNamed(host, 'Comets'))
    expect(navigated).deep.equals(['/teams/t1'])
    await click(linkNamed(host, 'the rules'))
    expect(opened).deep.equals(['https://example.com/rules'])
    expect(navigated).deep.equals(['/teams/t1'])
  })

  it('renders a javascript: link, or any other scheme, as plain text', async function () {
    const host = await show(
      '[Run me](javascript:alert(1)) [plain](http://example.com) [mail](mailto:a@example.com) [far](//example.com/x)'
    )
    expect(host.querySelectorAll('[role="link"]').length).equals(0)
    expect(host.textContent).equals('Run me plain mail far')
  })

  it('draws a link titled "path" as a way bubble with chevrons that navigates', async function () {
    const navigated: string[] = []
    const host = await show(
      'Team settings are here:\n[Home › Comets › Settings](/groups/team/t1/settings "path")\nTap it.',
      navigated
    )
    const way = byTestId('Tess way')!
    expect(way.getAttribute('aria-label')).equals(
      'Go to Home, Comets, Settings'
    )
    expect(way.textContent).equals(
      'Homechevron_rightCometschevron_rightSettingschevron_right'
    )
    const lines = [
      ...host.querySelectorAll('[data-testid="Tess markdown"] > div > div')
    ].map(node => node.textContent)
    expect(lines).deep.equals([
      'Team settings are here:',
      'Homechevron_rightCometschevron_rightSettingschevron_right',
      'Tap it.'
    ])
    await click(way)
    expect(navigated).deep.equals(['/groups/team/t1/settings'])
  })

  it('keeps a lone way bubble on its own, and a "path" title on a web link is an ordinary link', async function () {
    const host = await show(
      '[Home › Comets](/teams/t1 "path")\n\n[Docs](https://example.com "path")'
    )
    expect(host.querySelectorAll('[data-testid="Tess way"]').length).equals(1)
    expect(linkNamed(host, 'Docs').getAttribute('role')).equals('link')
  })

  it('draws a table and an HTML block as rich blocks', async function () {
    const host = await show(
      [
        '| Team | Runs |',
        '| --- | --- |',
        '| Comets | 12 |',
        '',
        '<svg width="40" height="20">',
        '<rect width="10" height="20"/>',
        '</svg>',
        '',
        '<!-- a note -->',
        '',
        '<svg width="4"><rect width="1" height="2"/></svg> inline'
      ].join('\n')
    )
    const frames = [...host.querySelectorAll('iframe')]
    expect(frames.length).equals(3)
    const [table, chart, inline] = frames.map(
      frame => frame.getAttribute('srcdoc') ?? ''
    )
    expect(table).includes('<table>')
    expect(table).includes('<td>Comets</td>')
    expect(chart).includes('<rect width="10" height="20"/>')
    expect(inline).includes('<svg width="4">')
    expect(host.textContent).not.includes('a note')
    expect(byLabel('Open full screen').getAttribute('role')).equals('button')
  })

  it('stands an image in by its words and keeps line breaks', async function () {
    const host = await show(
      '![a chart of runs](https://example.com/c.png) line one  \nline two<br>three <b>bold</b>'
    )
    expect(host.querySelector('img')).equals(null)
    expect(host.textContent).equals(
      'a chart of runs line one\nline two\nthree bold'
    )
  })
})

describe('Markdown helpers', function () {
  it('sorts links into app paths, https and nothing', function () {
    expect(linkTarget('/teams/t1')).deep.equals({
      kind: 'app',
      path: '/teams/t1'
    })
    expect(linkTarget('HTTPS://example.com')).deep.equals({
      kind: 'web',
      url: 'HTTPS://example.com'
    })
    for (const href of [
      'javascript:alert(1)',
      'http://example.com',
      '//example.com',
      'data:text/html,hi',
      'teams/t1'
    ])
      expect(linkTarget(href), href).equals(null)
  })

  it('decodes the character references the lexer keeps', function () {
    expect(
      decodeEntities('&amp; &lt;b&gt; &quot;q&quot; &apos;a&#39; &#x41;&nbsp;')
    ).equals('& <b> "q" \'a\' A ')
    expect(decodeEntities('&bogus; &#0; &#x110000;')).equals(
      '&bogus; &#0; &#x110000;'
    )
  })

  it('splits a way into its places', function () {
    expect(waySegments(' Home ›Comets›  Settings › ')).deep.equals([
      'Home',
      'Comets',
      'Settings'
    ])
  })
})
