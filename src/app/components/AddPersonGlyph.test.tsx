import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AddPersonGlyph } from './AddPersonGlyph'
import { AddPersonGlyph as NativeGlyph } from './AddPersonGlyph.native'
import { ADD_PERSON_GLYPH } from './addPersonGlyphShape'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

describe('the add-a-person glyph', function () {
  it('draws a head and shoulders, and a plus in a ringed circle at the upper right of the head', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <AddPersonGlyph color="#00aa66" background="#112233" size={42} />
      )
    })
    const svg = host.querySelector('[data-testid="addPersonGlyph"]')!
    expect(svg.getAttribute('width')).equals('42')
    expect(svg.getAttribute('aria-hidden')).equals('true')
    const [head, badge] = [...svg.querySelectorAll('circle')]
    expect(head.getAttribute('fill')).equals('#00aa66')
    // The badge sits above and to the right of the head's centre.
    expect(Number(badge.getAttribute('cx'))).greaterThan(
      ADD_PERSON_GLYPH.head.cx
    )
    expect(Number(badge.getAttribute('cy'))).lessThan(ADD_PERSON_GLYPH.head.cy)
    expect(badge.getAttribute('stroke')).equals('#112233')
    const plus = [...svg.querySelectorAll('path')].at(-1)!
    expect(plus.getAttribute('d')).equals(ADD_PERSON_GLYPH.plus)
    expect(plus.getAttribute('stroke')).equals('#112233')
  })

  it('is 24 points by default', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<AddPersonGlyph color="#000000" background="#ffffff" />)
    })
    expect(
      host
        .querySelector('[data-testid="addPersonGlyph"]')!
        .getAttribute('width')
    ).equals('24')
  })

  it('draws the same shapes on a phone', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <NativeGlyph color="#00aa66" background="#112233" size={30} />
      )
    })
    const svg = host.querySelector('svg')!
    expect(svg.getAttribute('width')).equals('30')
    expect(svg.querySelectorAll('circle')).length(2)
    expect(svg.querySelectorAll('path')).length(2)
    expect([...svg.querySelectorAll('path')].at(-1)!.getAttribute('d')).equals(
      ADD_PERSON_GLYPH.plus
    )
  })
})
