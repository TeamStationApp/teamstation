import { expect } from 'chai'
import { readdirSync, readFileSync } from 'fs'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'
import { join, relative } from 'path'

import {
  chatRowById,
  chatRowSelector,
  chatRowText,
  type NativeBounds,
  nativeRowInList
} from './chatRows'

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

/** A native hierarchy node, as maestro-d gives it. */
interface Node {
  type?: string
  id?: string
  text?: string
  label?: string
  bounds?: NativeBounds
  children?: Node[]
}

const at = (y: number, height = 72): NativeBounds => ({
  x: 0,
  y,
  width: 390,
  height
})

/**
 * The Chat tab on iOS as a legacy build draws it: no row carries a
 * `chat-conversation-<id>`, and the scope pills above the list are a
 * ScrollView of their own, full of id-less nodes, that comes first.
 */
function legacyIos(rowId?: string): { tree: Node; row: Node; list: Node } {
  const row: Node = {
    type: 'XCUIElementTypeButton',
    id: rowId,
    label: 'Hawks Members, Ec: practice moved, 2 unread',
    bounds: at(300)
  }
  const pills: Node = {
    type: 'XCUIElementTypeScrollView',
    bounds: at(100, 44),
    children: [
      { type: 'XCUIElementTypeButton', label: 'Members', bounds: at(100, 44) },
      { type: 'XCUIElementTypeButton', label: 'Fans', bounds: at(100, 44) }
    ]
  }
  const list: Node = {
    type: 'XCUIElementTypeScrollView',
    bounds: at(150, 600),
    children: [
      {
        type: 'XCUIElementTypeOther',
        children: [
          {
            type: 'XCUIElementTypeButton',
            label: 'Hawks Members Fans',
            bounds: at(228)
          },
          row
        ]
      }
    ]
  }
  return {
    tree: {
      type: 'XCUIElementTypeApplication',
      bounds: at(0, 844),
      children: [
        { type: 'XCUIElementTypeStaticText', label: 'Chat' },
        pills,
        list
      ]
    },
    row,
    list
  }
}

describe('a native chat row and the list it scrolls in', function () {
  const iosTitle = new RegExp(chatRowText('Hawks Members', 'ios'))
  const byTitle = (node: Node): boolean =>
    iosTitle.test(node.text ?? '') || iosTitle.test(node.label ?? '')

  it('finds the list holding a legacy row matched by its title, not the first ScrollView', function () {
    const { tree, row, list } = legacyIos()
    const found = nativeRowInList(tree, byTitle)
    expect(found?.row).equals(row)
    expect(found?.viewport).equals(list.bounds)
  })

  it('finds the same list for a row matched by its id', function () {
    const { tree, row, list } = legacyIos('chat-conversation-cnv_a')
    const found = nativeRowInList(
      tree,
      node => node.id === 'chat-conversation-cnv_a'
    )
    expect(found?.row).equals(row)
    expect(found?.viewport).equals(list.bounds)
  })

  it('finds the list of an Android row matched by its title text node', function () {
    const title: Node = {
      type: 'android.widget.TextView',
      text: 'Hawks Members',
      bounds: at(310, 24)
    }
    const list: Node = {
      type: 'android.widget.ScrollView',
      bounds: at(150, 600),
      children: [
        {
          type: 'android.view.ViewGroup',
          bounds: at(300),
          children: [title, { type: 'android.widget.TextView', text: '2' }]
        }
      ]
    }
    const tree: Node[] = [
      {
        type: 'android.widget.HorizontalScrollView',
        bounds: at(100, 44),
        children: [{ type: 'android.widget.TextView', text: 'Members' }]
      },
      list
    ]
    const android = new RegExp(chatRowText('Hawks Members', 'android'))
    const found = nativeRowInList(tree, node => android.test(node.text ?? ''))
    expect(found?.row).equals(title)
    expect(found?.viewport).equals(list.bounds)
  })

  it('has nothing until the row is there, with bounds, inside a list', function () {
    const { tree, row } = legacyIos()
    expect(nativeRowInList(tree, () => false)).equals(undefined)
    const unlisted: Node = { type: 'Other', children: [row] }
    expect(nativeRowInList(unlisted, byTitle)).equals(undefined)
    row.bounds = undefined
    expect(nativeRowInList(tree, byTitle)).equals(undefined)
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
        /\.e2e\.tsx?$|^e2e\/(?:tests|rigs|fixtures)\/.*\.tsx?$|^scripts\/.*\.(mjs|cjs|js|ts|sh)$/.test(
          relative(root, path)
        )
      )
        found.push(path)
    }
  }
  for (const dir of ['src', 'scripts', 'mobile', 'e2e']) walk(join(root, dir))
  return found.map(path => relative(root, path))
}

describe('chat row lookups in the end-to-end suites', function () {
  it('scan the suites under e2e/', function () {
    expect(suites()).includes('e2e/tests/app-shell/lists/list-screens.e2e.ts')
    expect(suites()).includes('e2e/rigs/chat2Maestro.ts')
  })

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
