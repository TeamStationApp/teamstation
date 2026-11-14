import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { RosterName } from './RosterName'

let root: Root | undefined
let host: HTMLDivElement

const mount = async (element: React.ReactElement): Promise<void> => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}
const texts = (): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('[dir="auto"]')
]

describe('a roster card’s name', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host.remove()
  })

  it('puts the slot, jersey and first name on one line and the last name on the next, wrapping between them', async function () {
    await mount(
      <RosterName
        player={{
          jersey: '1',
          fullName: 'Vladimir Guerrero',
          lastName: 'Guerrero'
        }}
        prefix="1."
        style={{ fontSize: 14 }}
      />
    )
    expect(texts().map(text => text.textContent)).deep.equals([
      '1. #1 Vladimir ',
      'Guerrero'
    ])
    const row = host.querySelector<HTMLElement>('[data-testid="Roster name"]')!
    expect(getComputedStyle(row).flexWrap).equals('wrap')
    expect(getComputedStyle(row).flexDirection).equals('row')
    // A browser drops the space that ends the first line, so the row puts a
    // space's width between the names, which a wrapped line does not get.
    expect(parseFloat(getComputedStyle(row).columnGap)).closeTo(14 * 0.26, 0.01)
    for (const text of texts()) {
      const style = getComputedStyle(text)
      expect(style.whiteSpace).equals('nowrap')
      expect(style.textOverflow).equals('ellipsis')
      expect(style.fontSize).equals('14px')
      // It may narrow to the card, and only by its ellipsis.
      expect(style.minWidth).equals('0px')
      expect(style.flexShrink).equals('1')
    }
  })

  it('leaves the space out of a phone’s first line, where the gap alone stands between the names', async function () {
    const os = Platform.OS
    Object.assign(Platform, { OS: 'ios' })
    try {
      await mount(
        <RosterName
          player={{ jersey: '27', fullName: 'Trea Turner', lastName: 'Turner' }}
          style={{ fontSize: 14 }}
        />
      )
    } finally {
      Object.assign(Platform, { OS: os })
    }
    // A phone measures a trailing space into the line's width.
    expect(texts().map(text => text.textContent)).deep.equals([
      '#27 Trea',
      'Turner'
    ])
    const row = host.querySelector<HTMLElement>('[data-testid="Roster name"]')!
    expect(parseFloat(getComputedStyle(row).columnGap)).closeTo(14 * 0.26, 0.01)
  })

  it('wraps a one-word name onto two lines, never shrunk', async function () {
    await mount(
      <RosterName
        player={{ jersey: '8', fullName: 'Maldonado' }}
        prefix="8."
        style={{ fontSize: 14 }}
      />
    )
    expect(host.querySelector('[data-testid="Roster name"]')).equals(null)
    expect(texts().map(text => text.textContent)).deep.equals([
      '8. #8 Maldonado'
    ])
    const style = getComputedStyle(texts()[0])
    expect(style.webkitLineClamp).equals('2')
    expect(style.fontSize).equals('14px')
  })
})
