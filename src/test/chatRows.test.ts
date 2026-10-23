import { expect } from 'chai'
import { readdirSync, readFileSync } from 'fs'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'
import { join, relative } from 'path'

import { chatRowById, chatRowSelector, chatRowText } from './chatRows'

/** A Chat tab list as the web draws it, with each row's whole name. */
function list(): JSDOM {
  return new JSDOM(`<!doctype html><body>
    <div aria-label="Hawks Members, practice moved">header copy</div>
    <div data-testid="chat-conversation-list">
      <div role="button" data-testid="chat-conversation-cnv_a"
        aria-label="Hawks Members, Ec: practice moved, 2 unread">a</div>
      <div role="button" data-testid="chat-conversation-cnv_b"
        aria-label="Hawks Members Fans">b</div>
      <div role="button" data-testid="chat-conversation-cnv_c"
        aria-label="Drew D">c</div>
      <div role="button" data-testid="chat-conversation-cnv_d"
        aria-label="Drew D2, hi">d</div>
      <div role="button" data-testid="chat-conversation-cnv_e"
        aria-label='Say "hi", now'>e</div>
    </div>
    <div data-testid="chat-list-pane">
      <div role="button" data-testid="chat-conversation-cnv_f"
        aria-label="Hawks Members, Practice update: please bring water and arrive at 5:30.">f</div>
    </div>
  </body>`)
}

function ids(dom: JSDOM, selector: string): string[] {
  return [...dom.window.document.querySelectorAll(selector)].map(
    node => node.getAttribute('data-testid') ?? '(none)'
  )
}

describe('chat rows by title', function () {
  it('finds a web row named by its title alone or followed by what it shows', function () {
    const dom = list()
    const inList = '[data-testid="chat-conversation-list"]'
    expect(ids(dom, chatRowSelector('Hawks Members', inList))).deep.equals([
      'chat-conversation-cnv_a'
    ])
    expect(ids(dom, chatRowSelector('Drew D', inList))).deep.equals([
      'chat-conversation-cnv_c'
    ])
    expect(ids(dom, chatRowSelector('Drew D2', inList))).deep.equals([
      'chat-conversation-cnv_d'
    ])
    expect(ids(dom, chatRowSelector('Say "hi"', inList))).deep.equals([
      'chat-conversation-cnv_e'
    ])
    expect(ids(dom, chatRowSelector('Hawks'))).deep.equals([])
    // A row with a preview inside the workspace's pane, as chatUiFollowup finds it.
    const pane = chatRowSelector(
      'Hawks Members',
      '[data-testid="chat-list-pane"]'
    )
    expect(ids(dom, pane)).deep.equals(['chat-conversation-cnv_f'])
  })

  it('keeps to buttons', function () {
    const dom = list()
    // The header copy shares the name but is no button.
    expect(ids(dom, chatRowSelector('Hawks Members'))).deep.equals([
      'chat-conversation-cnv_a',
      'chat-conversation-cnv_f'
    ])
  })

  it('finds a row by its conversation id', function () {
    expect(ids(list(), chatRowById('cnv_b'))).deep.equals([
      'chat-conversation-cnv_b'
    ])
  })

  it('matches the iOS row name by its leading title, and the Android title whole', function () {
    const ios = new RegExp(chatRowText('Hawks Members', 'ios'))
    expect(ios.test('Hawks Members')).equals(true)
    expect(ios.test('Hawks Members, hello 🎉, 1 unread')).equals(true)
    expect(ios.test('Hawks Members Fans')).equals(false)
    expect(ios.test('Old Hawks Members')).equals(false)
    const android = new RegExp(chatRowText('Hawks Members', 'android'))
    expect(android.test('Hawks Members')).equals(true)
    expect(android.test('Hawks Members, hello')).equals(false)
    // A title is literal text, not a pattern.
    const dotted = new RegExp(chatRowText('A.B (2)', 'ios'))
    expect(dotted.test('A.B (2), hi')).equals(true)
    expect(dotted.test('AxB (2)')).equals(false)
  })
})

/** Every end-to-end suite and script in the repository, by relative path. */
function suites(): string[] {
  const root = join(__dirname, '..', '..')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        /\.e2e\.tsx?$|^scripts\/.*\.(mjs|cjs|js|ts|sh)$/.test(
          relative(root, path)
        )
      )
        found.push(path)
    }
  }
  for (const dir of ['src', 'scripts', 'mobile']) walk(join(root, dir))
  return found.map(path => relative(root, path))
}

describe('chat row lookups in the end-to-end suites', function () {
  it('never match a scope chat row by its whole title', function () {
    const root = join(__dirname, '..', '..')
    // `[aria-label="Hawks Members"]`, also inside a page script's quotes.
    const exactCss =
      /aria-label=\\?"[^"^\\]*\b(?:Members|Staff|Fans|Announcements|Org)\\?"/
    // A native row found by text equal to a conversation's title.
    const exactText = /\btext:\s*[\w.]*(?:conversationLabel|\.title)\s*[},]/
    const offenders: string[] = []
    for (const path of suites()) {
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (exactCss.test(line) || exactText.test(line))
            offenders.push(`${path}:${index + 1}`)
        })
    }
    expect(offenders).deep.equals([])
  })
})
