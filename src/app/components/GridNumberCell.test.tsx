import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import {
  nextGridCell,
  NUMBER_COLUMNS,
  type NumberColumn,
  numberRefusal,
  useGridNumberEditor
} from './GridNumberCell'

type Values = Record<string, Record<NumberColumn, number>>

const TITLES: Record<NumberColumn, string> = {
  gameMinutes: 'Game MINS',
  bufferMinutes: 'Between MINS',
  regularGames: '# Regular',
  exhibitionGames: '# Exhibition'
}

const START: Values = {
  a: {
    gameMinutes: 90,
    bufferMinutes: 10,
    regularGames: 4,
    exhibitionGames: 1
  },
  b: { gameMinutes: 60, bufferMinutes: 5, regularGames: 8, exhibitionGames: 0 }
}

type Save = (
  seasonId: string,
  column: NumberColumn,
  value: number
) => Promise<string | null>

describe('the grid’s spreadsheet number cells', () => {
  let root: Root | undefined
  let writes: Array<[string, NumberColumn, number]>
  let save: Save
  const succeed: Save = async (...args) => {
    writes.push(args)
    return null
  }
  function Grid(): React.ReactElement {
    const [values, setValues] = useState(START)
    const editor = useGridNumberEditor({
      seasonIds: Object.keys(values),
      valueOf: (seasonId, column) => values[seasonId]?.[column],
      titleOf: column => TITLES[column],
      onSave: async (seasonId, column, value) => {
        const failure = await save(seasonId, column, value)
        if (failure == null)
          setValues(current => ({
            ...current,
            [seasonId]: { ...current[seasonId], [column]: value }
          }))
        return failure
      }
    })
    return (
      <View>
        {Object.keys(values).map(seasonId => (
          <View key={seasonId}>
            {NUMBER_COLUMNS.map(column =>
              editor.cell({
                seasonId,
                seasonName: `Season ${seasonId.toUpperCase()}`,
                column,
                style: { width: 80 },
                textStyle: { fontSize: 15 }
              })
            )}
          </View>
        ))}
        <p role="alert">{editor.error}</p>
      </View>
    )
  }
  async function mount(): Promise<void> {
    writes = []
    save = succeed
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Grid />
        </ThemeProvider>
      )
    })
  }
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  async function wait(milliseconds = 10): Promise<void> {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, milliseconds))
    })
  }
  async function tap(seasonId: string, column: NumberColumn): Promise<void> {
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          `[data-testid="grid-cell-${seasonId}-${column}"]`
        )!
        .click()
    })
    await wait()
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
  async function key(name: string, extra = {}): Promise<void> {
    await act(async () => {
      input().dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          bubbles: true,
          cancelable: true,
          ...extra
        })
      )
    })
    await wait()
  }
  async function blur(): Promise<void> {
    await act(async () => {
      input().blur()
    })
    await wait()
  }
  /** The open cell, focused, with its whole number selected. */
  function selected(seasonId: string, column: NumberColumn): void {
    expect(input().dataset.testid).equals(
      `grid-cell-input-${seasonId}-${column}`
    )
    expect(document.activeElement).equals(input())
    expect([input().selectionStart, input().selectionEnd]).deep.equals([
      0,
      input().value.length
    ])
  }
  function alert(): string {
    return document.querySelector('[role="alert"]')!.textContent ?? ''
  }
  function shown(seasonId: string, column: NumberColumn): string {
    return document.querySelector<HTMLElement>(
      `[data-testid="grid-cell-${seasonId}-${column}"]`
    )!.textContent!
  }
  /** The TextInput's own props, as React holds them. */
  function inputProps(): Record<string, unknown> {
    const node = input()
    const fiberKey = Object.keys(node).find(k => k.startsWith('__reactFiber'))!
    let fiber = (node as unknown as Record<string, unknown>)[fiberKey] as {
      memoizedProps?: Record<string, unknown>
      return?: unknown
    } | null
    let found: Record<string, unknown> | undefined
    while (fiber != null) {
      if (fiber.memoizedProps?.submitBehavior != null)
        found = fiber.memoizedProps
      fiber = fiber.return as typeof fiber
    }
    return found!
  }

  it('moves row by row through the number cells, and stops at the ends', () => {
    const ids = ['a', 'b']
    expect(
      nextGridCell(
        { seasonId: 'a', column: 'exhibitionGames' },
        ids,
        NUMBER_COLUMNS,
        'next'
      )
    ).deep.equals({ seasonId: 'b', column: 'gameMinutes' })
    expect(
      nextGridCell(
        { seasonId: 'b', column: 'gameMinutes' },
        ids,
        NUMBER_COLUMNS,
        'previous'
      )
    ).deep.equals({ seasonId: 'a', column: 'exhibitionGames' })
    expect(
      nextGridCell(
        { seasonId: 'a', column: 'gameMinutes' },
        ids,
        NUMBER_COLUMNS,
        'previous'
      )
    ).equals(undefined)
    expect(
      nextGridCell(
        { seasonId: 'b', column: 'exhibitionGames' },
        ids,
        NUMBER_COLUMNS,
        'next'
      )
    ).equals(undefined)
    expect(
      nextGridCell(
        { seasonId: 'gone', column: 'gameMinutes' },
        ids,
        NUMBER_COLUMNS,
        'next'
      )
    ).equals(undefined)
  })

  it('refuses numbers outside each column’s range and step', () => {
    expect(numberRefusal('gameMinutes', 'Game MINS', '47')).equals(
      'Game MINS: choose 30 to 600, in 5-minute steps.'
    )
    expect(numberRefusal('gameMinutes', 'Game MINS', '610')).not.equals(
      undefined
    )
    expect(numberRefusal('bufferMinutes', 'Between MINS', '0')).equals(
      undefined
    )
    expect(numberRefusal('regularGames', '# Regular', '0')).equals(undefined)
    expect(numberRefusal('regularGames', '# Regular', '')).equals(
      '# Regular: choose 0 to 200.'
    )
    expect(numberRefusal('exhibitionGames', '# Exhibition', '201')).equals(
      '# Exhibition: choose 0 to 200.'
    )
  })

  it('opens a tapped cell with its whole number selected, and typing replaces it', async () => {
    await mount()
    expect(document.querySelector('input')).equals(null)
    expect(
      document
        .querySelector('[data-testid="grid-cell-a-gameMinutes"]')!
        .getAttribute('aria-label')
    ).equals('Season A Game MINS: 90')
    expect(shown('a', 'gameMinutes')).equals('90')
    await tap('a', 'gameMinutes')
    expect(input().value).equals('90')
    expect(input().getAttribute('aria-label')).equals('Edit Season A Game MINS')
    expect(input().getAttribute('inputmode')).equals('numeric')
    expect(input().maxLength).equals(3)
    selected('a', 'gameMinutes')
    expect(inputProps()).deep.include({
      selectTextOnFocus: true,
      returnKeyType: 'done',
      submitBehavior: 'blurAndSubmit',
      keyboardType: 'number-pad'
    })
    // Whatever is typed over the selection replaces it; only digits stay.
    await fill('1a0-0')
    expect(input().value).equals('100')
    await key('Enter')
    expect(document.querySelector('input')).equals(null)
    expect(writes).deep.equals([['a', 'gameMinutes', 100]])
    expect(shown('a', 'gameMinutes')).equals('100')
  })

  it('saves on blur only when the number changed, and Escape restores it', async () => {
    await mount()
    await tap('a', 'bufferMinutes')
    await blur()
    expect(document.querySelector('input')).equals(null)
    await tap('a', 'bufferMinutes')
    await fill('010')
    await key('Enter')
    // 010 is still 10.
    expect(writes).deep.equals([])
    await tap('a', 'bufferMinutes')
    await fill('15')
    await blur()
    expect(writes).deep.equals([['a', 'bufferMinutes', 15]])
    expect(document.querySelector('input')).equals(null)
    await tap('a', 'regularGames')
    await fill('9')
    await key('Escape')
    expect(document.querySelector('input')).equals(null)
    expect(shown('a', 'regularGames')).equals('4')
    expect(writes).length(1)
    // Other keys, and keys while composing, leave the cell as it is.
    await tap('a', 'regularGames')
    await key('ArrowLeft')
    await key('Enter', { isComposing: true })
    await key('Enter', { keyCode: 229 })
    selected('a', 'regularGames')
  })

  it('saves with Tab and opens the next cell, Shift-Tab the previous, and closes past the last', async () => {
    await mount()
    await tap('a', 'gameMinutes')
    await fill('100')
    await key('Tab')
    selected('a', 'bufferMinutes')
    await fill('5')
    await key('Tab')
    selected('a', 'regularGames')
    await key('Tab', { shiftKey: true })
    selected('a', 'bufferMinutes')
    expect(input().value).equals('5')
    await tap('b', 'exhibitionGames')
    await fill('2')
    await key('Tab')
    expect(document.querySelector('input')).equals(null)
    expect(writes).deep.equals([
      ['a', 'gameMinutes', 100],
      ['a', 'bufferMinutes', 5],
      ['b', 'exhibitionGames', 2]
    ])
    // Opening another cell saves the open one first.
    await tap('b', 'regularGames')
    await fill('6')
    await tap('a', 'regularGames')
    selected('a', 'regularGames')
    expect(writes.at(-1)).deep.equals(['b', 'regularGames', 6])
  })

  it('keeps a refused number open and selected, with the reason', async () => {
    await mount()
    await tap('a', 'gameMinutes')
    await fill('47')
    await key('Enter')
    selected('a', 'gameMinutes')
    expect(alert()).equals('Game MINS: choose 30 to 600, in 5-minute steps.')
    // The same refusal again still reselects.
    await key('Enter')
    selected('a', 'gameMinutes')
    // A refused cell isn't left for another one.
    await tap('a', 'regularGames')
    selected('a', 'gameMinutes')
    await key('Escape')
    expect(alert()).equals('')
    expect(shown('a', 'gameMinutes')).equals('90')
    await tap('a', 'regularGames')
    await fill('')
    await key('Enter')
    expect(alert()).equals('# Regular: choose 0 to 200.')
    await fill('0')
    expect(alert()).equals('')
    await key('Enter')
    await tap('a', 'exhibitionGames')
    await fill('201')
    await blur()
    expect(alert()).equals('# Exhibition: choose 0 to 200.')
    selected('a', 'exhibitionGames')
    expect(writes).deep.equals([['a', 'regularGames', 0]])
  })

  it('keeps a failed save open with the server’s message, and refocuses once editable', async () => {
    await mount()
    let answer!: (failure: string | null) => void
    save = async (...args) => {
      writes.push(args)
      return await new Promise(resolve => {
        answer = resolve
      })
    }
    await tap('a', 'gameMinutes')
    await fill('120')
    const node = input()
    const focus = node.focus.bind(node)
    let refused = 0
    node.focus = () => {
      if (node.readOnly) refused++
      else focus()
    }
    await blur()
    expect(node.readOnly).equals(true)
    // While the save is in flight, nothing else starts.
    await act(async () => {
      node.click()
    })
    await key('Enter')
    await key('Tab')
    await key('Escape')
    await tap('b', 'gameMinutes')
    expect(writes).length(1)
    await act(async () => {
      answer('Choose game minutes from 30 to 600')
    })
    await wait()
    expect(refused).equals(0)
    expect(node.readOnly).equals(false)
    selected('a', 'gameMinutes')
    expect(input().value).equals('120')
    expect(alert()).equals('Choose game minutes from 30 to 600')
    // Leaving after a failure keeps the draft without trying again.
    await blur()
    expect(writes).length(1)
    save = async () => {
      throw new Error('Server down')
    }
    await act(async () => {
      input().focus()
    })
    await key('Enter')
    expect(alert()).equals('Server down')
    save = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- An unknown transport failure.
      throw 'network'
    }
    await key('Enter')
    expect(alert()).equals('That could not be saved. Try again.')
    save = succeed
    await key('Enter')
    expect(document.querySelector('input')).equals(null)
    expect(shown('a', 'gameMinutes')).equals('120')
  })

  it('does not come back after the grid unmounts during a save', async () => {
    await mount()
    let answer!: (failure: string | null) => void
    let fail!: (error: Error) => void
    save = async () =>
      await new Promise((resolve, reject) => {
        answer = resolve
        fail = reject
      })
    await tap('a', 'gameMinutes')
    await fill('120')
    await key('Enter')
    await act(async () => root?.unmount())
    root = undefined
    await act(async () => {
      answer(null)
    })
    await mount()
    save = async () =>
      await new Promise((resolve, reject) => {
        answer = resolve
        fail = reject
      })
    await tap('a', 'gameMinutes')
    await fill('120')
    await key('Enter')
    await act(async () => root?.unmount())
    root = undefined
    await act(async () => {
      fail(new Error('late'))
    })
    expect(document.querySelector('input')).equals(null)
  })

  for (const [os, keyboard] of [
    ['ios', 'numbers-and-punctuation'],
    ['android', 'number-pad']
  ] as const)
    it(`saves with Return on ${os}, whose keyboard has one`, async () => {
      const was = Platform.OS
      try {
        Platform.OS = os
        await mount()
        await tap('a', 'gameMinutes')
        const props = inputProps()
        expect(props.keyboardType).equals(keyboard)
        expect(props.inputMode).equals(undefined)
        await fill('95')
        await act(async () => {
          ;(props.onSubmitEditing as () => void)()
        })
        await wait()
        expect(writes).deep.equals([['a', 'gameMinutes', 95]])
        expect(document.querySelector('input')).equals(null)
      } finally {
        Platform.OS = was
      }
    })

  it('ignores Return’s submit on web, where Enter saves', async () => {
    await mount()
    await tap('a', 'gameMinutes')
    await fill('95')
    const props = inputProps()
    await act(async () => {
      ;(props.onSubmitEditing as () => void)()
    })
    expect(writes).deep.equals([])
  })
})
