import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Dimensions, Platform, Pressable, Text, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { UmpireMask } from '../umpires/UmpireMask'
import { ButtonIcon } from './ButtonIcon'
import { Icon } from './Icon'

let root: Root | undefined
let host: HTMLDivElement | undefined
const originalOS = Platform.OS
const originalWindow = Dimensions.get('window')
const originalGet = Dimensions.get.bind(Dimensions)
const originalAddEventListener = Dimensions.addEventListener.bind(Dimensions)
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
  Dimensions.get = originalGet
  Dimensions.addEventListener = originalAddEventListener
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
    expect(slot.style.width).equals('')
    expect(
      slot.querySelector<HTMLElement>('[style*="opacity: 0"]')?.style.fontSize
    ).equals('26px')
    const lines = slot.querySelectorAll<HTMLElement>(
      '[style*="background-color"]'
    )
    expect(lines.length).equals(3)
    for (const line of Array.from(lines))
      expect(line.style.backgroundColor).equals('rgb(255, 0, 0)')
    await render(
      <ButtonIcon name="close">
        <Text>×</Text>
      </ButtonIcon>
    )
    expect(
      node.querySelector<HTMLElement>('[style*="font-size: 14px"]')
    ).not.equals(null)
  })
  it('preserves the styled text box and uses original font metrics for its intrinsic width', async function () {
    Platform.OS = 'ios'
    for (const textAlign of ['left', 'center', 'right'] as const) {
      const node = await render(
        <ButtonIcon name="chevron_right">
          <Text
            style={{
              width: 42,
              height: 30,
              minWidth: 40,
              minHeight: 28,
              maxWidth: 44,
              backgroundColor: 'red',
              borderWidth: 2,
              borderRadius: 7,
              paddingRight: 4,
              fontSize: 22,
              lineHeight: 24,
              textAlign
            }}
          >
            ›
          </Text>
        </ButtonIcon>
      )
      const box = node.firstElementChild as HTMLElement
      expect(box.style.width).equals('42px')
      expect(box.style.height).equals('30px')
      expect(box.style.minWidth).equals('40px')
      expect(box.style.minHeight).equals('28px')
      expect(box.style.maxWidth).equals('44px')
      expect(box.style.borderTopLeftRadius).equals('7px')
      expect(box.style.backgroundColor).equals('rgb(255, 0, 0)')
      expect(box.style.alignItems).equals(
        textAlign === 'left'
          ? 'flex-start'
          : textAlign === 'right'
            ? 'flex-end'
            : 'center'
      )
      const metric = box.querySelector<HTMLElement>('[style*="opacity: 0"]')!
      expect(metric.textContent).equals('›')
      expect(metric.style.fontSize).equals('22px')
      expect(metric.style.lineHeight).equals('24px')
      expect(metric.style.width).equals('')
      expect(metric.style.fontFamily).equals('')
    }
  })
  it('does not subscribe web icons to dimension changes', async function () {
    Platform.OS = 'web'
    let subscriptions = 0
    Dimensions.addEventListener = () => {
      subscriptions++
      return { remove: () => {} }
    }
    for (const name of ['home', 'menu'] as const)
      await render(<ButtonIcon name={name} />)
    expect(subscriptions).equals(0)
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
    expect(slot.querySelector('svg')?.getAttribute('width')).equals('18')
  })
  it('tracks font scale, preserving explicit opt-out and maximum size', async function () {
    Platform.OS = 'android'
    let change:
      | ((value: {
          window: typeof originalWindow
          screen: typeof originalWindow
        }) => void)
      | undefined
    Dimensions.addEventListener = (_type, handler) => {
      change = value => {
        handler(value)
      }
      return { remove: () => {} }
    }
    const node = await render(<ButtonIcon name="home" />)
    const scaled = { ...originalWindow, fontScale: 2 }
    Dimensions.get = () => scaled
    await act(async () => {
      change?.({ window: scaled, screen: scaled })
    })
    expect((node.firstElementChild as HTMLElement).style.width).equals('40px')
    for (const [props, width] of [
      [{ allowFontScaling: false }, '14px'],
      [{ maxFontSizeMultiplier: 1.5 }, '21px']
    ] as const) {
      await render(
        <ButtonIcon name="more">
          <Text {...props}>•••</Text>
        </ButtonIcon>
      )
      expect(
        node.querySelector<HTMLElement>(`[style*="width: ${width}"]`)
      ).not.equals(null)
    }
  })
  it('preserves spacing and overlay styles once, outside the centered artwork', async function () {
    Platform.OS = 'ios'
    const style = {
      position: 'absolute' as const,
      top: 3,
      right: 5,
      paddingRight: 4,
      marginLeft: 2,
      opacity: 0.5,
      zIndex: 8,
      transform: [{ translateX: 1 }],
      fontSize: 18
    }
    for (const name of ['chevron_right', undefined] as const) {
      const node = await render(
        name == null ? (
          <ButtonIcon>
            <Text style={style}>›</Text>
          </ButtonIcon>
        ) : (
          <ButtonIcon name={name}>
            <Text style={style}>›</Text>
          </ButtonIcon>
        )
      )
      const outer = node.firstElementChild as HTMLElement
      expect(outer.style.paddingRight).equals('4px')
      expect(outer.style.marginLeft).equals('2px')
      expect(outer.style.zIndex).equals('8')
      expect(outer.style.opacity).equals('0.5')
      expect(outer.style.transform).equals('translateX(1px)')
      expect(outer.querySelectorAll('[style*="top: 3px"]').length).equals(0)
      expect(outer.querySelectorAll('[style*="padding-right"]').length).equals(
        0
      )
    }
  })
  it('centers the custom reply, more and check artwork on native', async function () {
    Platform.OS = 'android'
    for (const name of ['reply', 'more', 'check', 'pin'] as const) {
      const node = await render(
        <ButtonIcon name={name} size={1.5} color="blue">
          <Text>{name}</Text>
        </ButtonIcon>
      )
      const slot = node.querySelector<HTMLElement>('[style*="width: 24px"]')!
      expect(slot).not.equals(null)
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
  it('preserves the umpire mask artwork and its single action target on every platform', async function () {
    let artwork: string | undefined
    for (const os of ['web', 'ios', 'android'] as const) {
      Platform.OS = os
      let presses = 0
      const node = await render(
        <UmpireMask
          onPress={() => {
            presses++
          }}
        />
      )
      const buttons = node.querySelectorAll<HTMLElement>('[role="button"]')
      expect(buttons.length).equals(1)
      expect(buttons[0].getAttribute('aria-label')).equals('Umpire schedule')
      expect(buttons[0].style.width).equals('48px')
      expect(buttons[0].style.height).equals('48px')
      const drawing = node.querySelector('svg')!
      expect(drawing.getAttribute('width')).equals('25.6')
      artwork ??= drawing.outerHTML
      expect(drawing.outerHTML).equals(artwork)
      await act(async () => {
        buttons[0].click()
      })
      expect(presses).equals(1)
    }
  })
})
