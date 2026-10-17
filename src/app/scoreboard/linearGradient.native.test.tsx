import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import LinearGradient from './linearGradient.native'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

/** Lays each gradient's box out at `width` by `height`, as a phone would. */
async function layOut(
  host: HTMLElement,
  width: number,
  height: number
): Promise<void> {
  const boxes = [...host.querySelectorAll<HTMLElement>('*')].filter(
    node =>
      typeof (node as { __reactLayoutHandler?: unknown })
        .__reactLayoutHandler === 'function'
  ) as Array<HTMLElement & { __reactLayoutHandler: (event: unknown) => void }>
  for (const box of boxes)
    await act(async () => {
      box.__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width, height } }
      })
    })
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
  return host
}

describe('the board’s gradient on a phone (C4)', function () {
  it('maps the colours to evenly spaced stops along start to end', async function () {
    const host = await render(
      <LinearGradient
        colors={['#003087', '#3266ad', '#ffffff']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ width: 200, height: 56, borderRadius: 8 }}
      >
        <Text>Kestrels</Text>
      </LinearGradient>
    )
    await layOut(host, 200, 56)
    const gradient = host.querySelector('linearGradient')!
    expect(gradient.getAttribute('x1')).equals('0')
    expect(gradient.getAttribute('y1')).equals('0')
    expect(gradient.getAttribute('x2')).equals('1')
    expect(gradient.getAttribute('y2')).equals('1')
    const stops = [...gradient.querySelectorAll('stop')].map(stop => [
      stop.getAttribute('offset'),
      stop.getAttribute('stop-color')
    ])
    expect(stops).deep.equals([
      ['0', '#003087'],
      ['0.5', '#3266ad'],
      ['1', '#ffffff']
    ])
    // The rectangle is painted with this gradient, by its own id.
    const id = gradient.getAttribute('id')!
    expect(id).match(/^gradient[A-Za-z0-9_-]+$/)
    expect(host.querySelector('rect')?.getAttribute('fill')).equals(
      `url(#${id})`
    )
    // The children draw over it, inside the box the caller styled.
    expect(host.textContent).equals('Kestrels')
  })

  it('runs top to bottom down the middle by default, and gives two the same', async function () {
    const host = await render(
      <>
        <LinearGradient colors={['#8B4513', '#DAA520']} />
        <LinearGradient colors={['#000000']} />
      </>
    )
    await layOut(host, 100, 40)
    const [first, second] = [...host.querySelectorAll('linearGradient')]
    expect(
      ['x1', 'y1', 'x2', 'y2'].map(name => first.getAttribute(name))
    ).deep.equals(['0.5', '0', '0.5', '1'])
    expect(
      [...first.querySelectorAll('stop')].map(stop =>
        stop.getAttribute('offset')
      )
    ).deep.equals(['0', '1'])
    expect(first.getAttribute('id')).not.equals(second.getAttribute('id'))
    expect(
      [...second.querySelectorAll('stop')].map(stop =>
        stop.getAttribute('offset')
      )
    ).deep.equals(['0'])
  })

  it('fills the box from the first frame, then at its laid-out size, and again when it grows', async function () {
    const host = await render(
      <LinearGradient colors={['#003087', '#3266ad']} style={{ flex: 1 }}>
        <Text>Kestrels</Text>
      </LinearGradient>
    )
    // Painted from the first frame, filling the box, before it has a size.
    const rect = (): Element => host.querySelector('rect')!
    expect([
      rect().getAttribute('width'),
      rect().getAttribute('height')
    ]).deep.equals(['100%', '100%'])
    expect(host.textContent).equals('Kestrels')
    await layOut(host, 120, 56)
    expect([
      rect().getAttribute('width'),
      rect().getAttribute('height')
    ]).deep.equals(['120', '56'])
    // A team bar widened after its first layout is painted to its new edge.
    await layOut(host, 210, 56)
    expect(rect().getAttribute('width')).equals('210')
  })

  it('fills the inside of a bordered box, its border off each side', async function () {
    const host = await render(
      <LinearGradient
        colors={['#003087', '#3266ad']}
        style={{ borderWidth: 2, borderLeftWidth: 3 }}
      >
        <Text>Kestrels</Text>
      </LinearGradient>
    )
    await layOut(host, 120, 56)
    const rect = host.querySelector('rect')!
    expect([
      rect.getAttribute('width'),
      rect.getAttribute('height')
    ]).deep.equals(['115', '52'])
  })
})
