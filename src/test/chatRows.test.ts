import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

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
  })

  it('keeps to buttons', function () {
    const dom = list()
    // The header copy shares the name but is no button.
    expect(ids(dom, chatRowSelector('Hawks Members'))).deep.equals([
      'chat-conversation-cnv_a'
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
