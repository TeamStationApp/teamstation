import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { TeamStationClient } from '../../common/api'
import type { UmpireGameRow } from '../../common/umpireSchedule'
import { ThemeProvider } from '../theme/ThemeContext'
import { nextNoteCell, useUmpireNoteEditor } from './useUmpireNoteEditor'

describe('spreadsheet umpire notes', () => {
  let root: Root | undefined
  const types = ['color', 'contact'].map((id, position) => ({
    id,
    name: id,
    position,
    inUse: true
  }))
  const rows = ['a', 'b', 'c'].map(
    id =>
      ({
        id,
        home: 'Home',
        away: 'Away',
        date: id,
        umpireNotes: { color: id === 'b' ? 'Gold' : '' }
      }) as unknown as UmpireGameRow
  )
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  let writes: unknown[]
  function Grid({
    scope = 'league',
    editable = true
  }: {
    scope?: string
    editable?: boolean
  }): React.ReactElement {
    const [games, setGames] = useState(rows)
    const editor = useUmpireNoteEditor({
      client,
      scope,
      games,
      types,
      editable,
      onSaved: (cell, value) => {
        setGames(gs =>
          gs.map(g =>
            g.id === cell.game
              ? { ...g, umpireNotes: { ...g.umpireNotes, [cell.type]: value } }
              : g
          )
        )
      }
    })
    return (
      <div>
        <p role="alert">{editor.error}</p>
        {games.map(g => (
          <div key={g.id}>
            {types.map(t => (
              <div key={t.id}>{editor.cell(g, t)}</div>
            ))}
          </div>
        ))}
        <button
          onClick={() => {
            editor.discard()
          }}
        >
          Discard note changes
        </button>
        <button
          onClick={() => {
            editor.finish().catch(() => undefined)
          }}
        >
          Finish
        </button>
      </div>
    )
  }
  async function mount(): Promise<void> {
    writes = []
    client.saveUmpireNote = async (...args) => {
      writes.push(args)
      return { value: args[3] }
    }
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await render()
  }
  async function render(scope = 'league', editable = true): Promise<void> {
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Grid scope={scope} editable={editable} />
        </ThemeProvider>
      )
    })
  }
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  async function click(game: string, type: string): Promise<void> {
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          `[data-testid="umpire-note-${game}-${type}"]`
        )!
        .click()
    })
  }
  function input(): HTMLInputElement {
    return document.querySelector('input')!
  }
  async function fill(value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input(), value)
      input().dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  async function key(key: string, extra = {}): Promise<void> {
    await act(async () => {
      input().dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          ...extra
        })
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
  function focused(game: string, type: string): void {
    expect(input().dataset.testid).equals(`umpire-note-input-${game}-${type}`)
    expect(document.activeElement).equals(input())
  }
  it('navigates the visible grid and stops at boundaries or missing cells', () => {
    expect(
      nextNoteCell(
        { game: 'a', type: 'color' },
        ['a', 'c'],
        ['color', 'contact'],
        'down'
      )
    ).deep.equals({ game: 'c', type: 'color' })
    expect(
      nextNoteCell(
        { game: 'c', type: 'color' },
        ['a', 'c'],
        ['color', 'contact'],
        'previous'
      )
    ).deep.equals({ game: 'a', type: 'contact' })
    for (const cell of [
      { game: 'missing', type: 'color' },
      { game: 'a', type: 'missing' }
    ])
      expect(nextNoteCell(cell, ['a'], ['color'], 'down')).equals(undefined)
    expect(
      nextNoteCell({ game: 'a', type: 'color' }, ['a'], ['color'], 'previous')
    ).equals(undefined)
  })
  it('saves with Enter, selects existing text, tabs right and wraps, reverses, cancels and clears', async () => {
    await mount()
    expect(input()).equals(null)
    await click('a', 'color')
    await fill('Blue')
    await key('Enter')
    focused('b', 'color')
    expect(input().value).equals('Gold')
    expect([input().selectionStart, input().selectionEnd]).deep.equals([0, 4])
    await key('Tab')
    focused('b', 'contact')
    await fill('Demo')
    await key('Tab')
    focused('c', 'color')
    await key('Tab', { shiftKey: true })
    focused('b', 'contact')
    await fill('Discard')
    await key('Escape')
    expect(input()).equals(null)
    await click('b', 'contact')
    expect(input().value).equals('Demo')
    await fill('   ')
    await key('Enter')
    focused('c', 'contact')
    await key('Tab')
    expect(input()).equals(null)
    expect(writes).deep.equals([
      ['a', 'color', '', 'Blue'],
      ['b', 'contact', '', 'Demo'],
      ['b', 'contact', 'Demo', '']
    ])
  })
  it('commits blur and click once, and ignores fast keys during the save', async () => {
    await mount()
    let resolve!: (value: { value: string }) => void
    client.saveUmpireNote = async (...args) => {
      writes.push(args)
      return await new Promise(_resolve => {
        resolve = _resolve
      })
    }
    await click('a', 'color')
    await fill('Blue')
    await act(async () => {
      input().blur()
    })
    await click('a', 'contact')
    await key('Enter')
    await key('Escape')
    expect(writes).length(1)
    await act(async () => {
      resolve({ value: 'Blue' })
    })
    focused('a', 'contact')
  })
  it('uses native submit to save and focus the next row with its text selected', async () => {
    await mount()
    await click('a', 'color')
    await fill('Blue')
    const node = input()
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber'))!
    let fiber = (node as unknown as Record<string, unknown>)[key] as {
      memoizedProps?: { onSubmitEditing?: () => void; submitBehavior?: string }
      return?: unknown
    } | null
    let submit: (() => void) | undefined
    while (fiber != null) {
      if (fiber.memoizedProps?.submitBehavior === 'submit')
        submit = fiber.memoizedProps.onSubmitEditing
      fiber = fiber.return as typeof fiber
    }
    expect(submit).a('function')
    const os = Platform.OS
    try {
      Platform.OS = 'ios'
      await act(async () => {
        submit!()
      })
    } finally {
      Platform.OS = os
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    focused('b', 'color')
    expect([input().selectionStart, input().selectionEnd]).deep.equals([0, 4])
    expect(writes).deep.equals([['a', 'color', '', 'Blue']])
  })
  it('discards a permanently conflicting native draft without saving again', async () => {
    await mount()
    const os = Platform.OS
    try {
      Platform.OS = 'ios'
      await click('a', 'color')
      await fill('Conflicting value')
      let attempts = 0
      client.saveUmpireNote = async () => {
        attempts++
        throw new Error(
          'Note changed elsewhere. Reload to edit the latest value.'
        )
      }
      const button = (text: string): HTMLButtonElement =>
        [...document.querySelectorAll('button')].find(
          n => n.textContent === text
        )!
      await act(async () => {
        button('Finish').click()
      })
      expect(attempts).equals(1)
      expect(input().value).equals('Conflicting value')
      await act(async () => {
        input().blur()
      })
      await act(async () => {
        button('Discard note changes').click()
      })
      expect(document.querySelector('input')).equals(null)
      expect(document.querySelector('[role="alert"]')!.textContent).equals('')
      await act(async () => {
        button('Finish').click()
      })
      expect(attempts).equals(1)
    } finally {
      Platform.OS = os
    }
  })
  it('restores failed-save focus only after the input is editable again', async () => {
    await mount()
    await click('a', 'color')
    await fill('Blue')
    let reject!: (error: Error) => void
    client.saveUmpireNote = async () =>
      await new Promise<{ value: string }>((_resolve, _reject) => {
        reject = _reject
      })
    const node = input()
    const focus = node.focus.bind(node)
    let refused = 0
    node.focus = () => {
      if (node.readOnly) refused++
      else focus()
    }
    await act(async () => {
      node.blur()
    })
    expect(node.readOnly).equals(true)
    await act(async () => {
      reject(new Error('Try again'))
    })
    expect(refused).equals(0)
    expect(node.readOnly).equals(false)
    focused('a', 'color')
    expect(node.value).equals('Blue')
  })
  for (const platform of ['web', 'ios'] as const)
    it(`retries an edited failed note on blur on ${platform}`, async () => {
      await mount()
      const os = Platform.OS
      try {
        Platform.OS = platform
        await click('a', 'color')
        await fill('Blue')
        client.saveUmpireNote = async (...args) => {
          writes.push(args)
          if (writes.length === 1) throw new Error('Temporary network failure')
          return { value: args[3] }
        }
        await act(async () => {
          input().blur()
        })
        focused('a', 'color')
        expect(document.body.textContent).contains('Temporary network failure')
        await fill('Green')
        await act(async () => {
          input().blur()
        })
        expect(writes).deep.equals([
          ['a', 'color', '', 'Blue'],
          ['a', 'color', '', 'Green']
        ])
        expect(document.querySelector('input')).equals(null)
        expect(document.body.textContent).not.contains(
          'Temporary network failure'
        )
        await click('a', 'color')
        expect(input().value).equals('Green')
      } finally {
        Platform.OS = os
      }
    })
  it('retains a failed draft and focus for retry and ignores composing Enter', async () => {
    await mount()
    await click('a', 'color')
    await fill('Blue')
    await key('Enter', { isComposing: true })
    focused('a', 'color')
    await key('Enter', { keyCode: 229 })
    expect(writes).length(0)
    await key('ArrowLeft')
    expect(writes).length(0)
    client.saveUmpireNote = async () => {
      throw new Error('Changed elsewhere')
    }
    await key('Enter')
    focused('a', 'color')
    expect(input().value).equals('Blue')
    expect(document.body.textContent).contains('Changed elsewhere')
    client.saveUmpireNote = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an unknown transport failure.
      throw 'network'
    }
    await key('Enter')
    expect(document.body.textContent).contains('Could not save this note')
    client.saveUmpireNote = async (...args) => {
      writes.push(args)
      return { value: args[3] }
    }
    await key('Enter')
    focused('b', 'color')
    expect(writes).length(1)
  })
  it('does not resurrect an editor after the league changes or the grid unmounts', async () => {
    await mount()
    let resolve!: (value: { value: string }) => void
    client.saveUmpireNote = async () =>
      await new Promise(_resolve => {
        resolve = _resolve
      })
    await click('a', 'color')
    await fill('Blue')
    await key('Enter')
    await render('other')
    expect(input()).equals(null)
    await act(async () => {
      resolve({ value: 'Blue' })
    })
    expect(input()).equals(null)
    await render('other', false)
    expect(
      document.querySelector('[data-testid="umpire-note-a-color"]')
    ).equals(null)
    expect(document.body.textContent).contains('Gold')
    await render('other', true)
    await click('a', 'color')
    await fill('Gold')
    await key('Enter')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await act(async () => {
      resolve({ value: 'Gold' })
    })
    expect(input()).equals(null)
  })
})
