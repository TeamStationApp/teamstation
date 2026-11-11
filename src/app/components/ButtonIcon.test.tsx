import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform, Pressable, Text, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { ButtonIcon } from './ButtonIcon'
import { Icon } from './Icon'

let root: Root | undefined
let host: HTMLDivElement | undefined
const originalOS = Platform.OS
async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  host ??= document.body.appendChild(document.createElement('div'))
  root ??= createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
  host = undefined
  Platform.OS = originalOS
})

describe('button icon placement', function () {
  it('preserves the exact web icon output, including defaults and explicit size/color', async function () {
    Platform.OS = 'web'
    for (const props of [
      { name: 'home' as const },
      { name: 'settings' as const, size: 2, color: '#123456' }
    ]) {
      const node = await render(<Icon {...props} />)
      const before = node.innerHTML
      await render(<ButtonIcon {...props} />)
      expect(node.innerHTML).equals(before)
    }
  })
  it('preserves custom web text and vector output without adding a wrapper', async function () {
    Platform.OS = 'web'
    const glyph = <Text style={{ fontSize: 26, color: 'red' }}>☰</Text>
    const node = await render(glyph)
    const before = node.innerHTML
    await render(<ButtonIcon name="menu">{glyph}</ButtonIcon>)
    expect(node.innerHTML).equals(before)
    const vector = <View testID="vector" style={{ width: 16, height: 20 }} />
    await render(vector)
    const vectorBefore = node.innerHTML
    await render(<ButtonIcon>{vector}</ButtonIcon>)
    expect(node.innerHTML).equals(vectorBefore)
  })
  for (const os of ['ios', 'android'] as const) {
    it(`uses natural font metrics in a square slot on ${os}`, async function () {
      Platform.OS = os
      const node = await render(
        <ButtonIcon name="home" size={2} color="#123456" />
      )
      const slot = node.firstElementChild as HTMLElement
      const glyph = slot.firstElementChild as HTMLElement
      expect(slot.style.width).equals('32px')
      expect(slot.style.height).equals('32px')
      expect(slot.style.justifyContent).equals('center')
      expect(slot.style.alignItems).equals('center')
      expect(glyph.style.lineHeight).equals('')
      expect(glyph.style.fontSize).equals('32px')
      expect(glyph.style.transform).equals('translateY(-3.2px)')
      expect(glyph.style.color).equals('rgb(18, 52, 86)')
      expect(slot.getAttribute('aria-hidden')).equals('true')
      await render(<ButtonIcon name="settings" />)
      expect((node.firstElementChild as HTMLElement).style.width).equals('20px')
    })
  }
  it('takes size and color from existing custom text and centers the native menu strokes', async function () {
    Platform.OS = 'ios'
    const node = await render(
      <ButtonIcon name="menu">
        <Text style={[{ fontSize: 26 }, { color: 'red' }]}>☰</Text>
      </ButtonIcon>
    )
    const slot = node.firstElementChild as HTMLElement
    expect(slot.style.width).equals('26px')
    const drawing = slot.firstElementChild as HTMLElement
    expect(drawing.children.length).equals(3)
    for (const line of Array.from(drawing.children))
      expect((line as HTMLElement).style.backgroundColor).equals(
        'rgb(255, 0, 0)'
      )
    await render(
      <ButtonIcon name="close">
        <Text>×</Text>
      </ButtonIcon>
    )
    expect((node.firstElementChild as HTMLElement).style.width).equals('20px')
  })
  it('keeps a native selection mark anchored over its image', async function () {
    Platform.OS = 'ios'
    const node = await render(
      <ButtonIcon name="check">
        <Text style={{ position: 'absolute', top: 3, right: 5, fontSize: 18 }}>
          ✓
        </Text>
      </ButtonIcon>
    )
    const slot = node.firstElementChild as HTMLElement
    expect(slot.style.position).equals('absolute')
    expect(slot.style.top).equals('3px')
    expect(slot.style.right).equals('5px')
    expect(slot.style.width).equals('18px')
  })
  it('centers the custom reply, more and check artwork on native', async function () {
    Platform.OS = 'android'
    for (const name of ['reply', 'more', 'check', 'pin'] as const) {
      const node = await render(
        <ButtonIcon name={name} size={1.5} color="blue">
          <Text>{name}</Text>
        </ButtonIcon>
      )
      const slot = node.firstElementChild as HTMLElement
      expect(slot.style.width).equals('24px')
      expect(slot.textContent).equals('')
      if (name === 'more')
        expect(slot.firstElementChild?.children.length).equals(3)
      else
        expect(slot.querySelector('path')?.getAttribute('stroke')).equals(
          'blue'
        )
    }
  })
  it('provides menu artwork when no web override was supplied', async function () {
    Platform.OS = 'web'
    const node = await render(<ButtonIcon name="menu" />)
    expect(node.querySelectorAll('[style*="background-color"]').length).equals(
      3
    )
  })
  it('centers native vector artwork without forcing a square or font correction', async function () {
    Platform.OS = 'android'
    const node = await render(
      <ButtonIcon>
        <View testID="vector" style={{ width: 18, height: 22 }} />
      </ButtonIcon>
    )
    const slot = node.firstElementChild as HTMLElement
    expect(slot.style.width).equals('')
    expect(slot.style.transform).equals('')
    expect((slot.firstElementChild as HTMLElement).style.height).equals('22px')
  })
  it('keeps the enclosing button as the only target and invokes its action once', async function () {
    Platform.OS = 'ios'
    let presses = 0
    const node = await render(
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => {
          presses++
        }}
      >
        <ButtonIcon name="settings" />
      </Pressable>
    )
    expect(node.querySelectorAll('[role="button"]').length).equals(1)
    await act(async () => {
      node.querySelector<HTMLElement>('[role="button"]')!.click()
    })
    expect(presses).equals(1)
  })
})
