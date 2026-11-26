import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { transformSync } from 'esbuild'
import React from 'react'

import type { Theme } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import type { AppNavProps } from './AppNav'
import * as navClearance from './navClearance'
import { SystemTabBar as UnsupportedTabBar } from './SystemTabBar'
import * as tabBarModel from './tabBarModel'
import type { NativeProps } from './TSTabBarNativeComponent'

function loadNative(
  name: string,
  mocks: Record<string, unknown>,
  development = false
): NodeJS.Module['exports'] {
  const file = resolve('src/app/components', name)
  const loaded = new Module(file)
  loaded.require = (id: string) => {
    if (!(id in mocks)) throw new Error('Unexpected native import ' + id)
    return mocks[id]
  }
  const compiled = transformSync(readFileSync(file, 'utf8'), {
    loader: 'tsx',
    format: 'cjs',
    sourcefile: file,
    sourcemap: 'inline',
    define: { __DEV__: String(development) }
  })
  ;(
    loaded as unknown as { _compile: (code: string, path: string) => void }
  )._compile(compiled.code, file)
  return loaded.exports
}
type RenderedBar = React.ReactElement<{
  children: React.ReactElement<NativeProps>
  style: { bottom: number }
}>

function renderBar(
  theme: Theme,
  options: AppNavProps & { reduced?: boolean; compact?: boolean }
): RenderedBar {
  const mocks: Record<string, unknown> = {
    react: React,
    'react-native': { View: 'View' },
    '../platform/safeArea': { useInsets: () => ({ bottom: 34 }) },
    '../theme/ThemeContext': { useTheme: () => theme },
    './tabBarModel': tabBarModel,
    './navClearance': navClearance,
    './navGeometry': { NAV_BOTTOM_GAP: 21, NAV_NATIVE_HEIGHT_ABOVE_INSET: 49 },
    './TSTabBarNativeComponent': 'UITabBar'
  }
  const element = loadNative('SystemTabBar.ios.tsx', mocks).SystemTabBar(
    options
  ) as RenderedBar
  return element
}

describe('the UIKit tab bar bridge', () => {
  it('registers the TSTabBar native host for iOS', () => {
    const host = Symbol('tab bar host')
    const registrations: unknown[][] = []
    const component = loadNative('TSTabBarNativeComponent.ts', {
      'react-native': {
        codegenNativeComponent: (...args: unknown[]) => {
          registrations.push(args)
          return host
        }
      }
    })
    expect(component.default).equals(host)
    expect(registrations).deep.equals([
      ['TSTabBar', { excludedPlatforms: ['android'] }]
    ])
  })

  it('uses the normal floating position while the offline banner is absent', () => {
    const bar = renderBar(tsBallpark, {
      selected: 'home',
      mode: 'floating',
      onSelect: () => {}
    })
    expect(bar.props.style.bottom).equals(0)
  })
  for (const theme of [tsBallpark, tsDark])
    it(
      'uses the supplied ' + (theme.isDark ? 'dark' : 'light') + ' app theme',
      () => {
        const selected: string[] = []
        const heights: number[] = []
        const bar = renderBar(theme, {
          selected: 'home',
          mode: 'floating',
          onSelect: id => selected.push(id),
          onHeight: height => heights.push(height),
          dots: { chat: true },
          bannerHeight: 42
        })
        const native = bar.props.children.props
        expect(bar.props.style.bottom).equals(55)
        expect(native.dark).equals(theme.isDark)
        expect(native.activeColor).equals(theme.navActiveColor)
        expect(native.inactiveColor).equals(theme.navInactiveColor)
        expect(native.badgeColor).equals(theme.liveColor)
        expect(native.selectedId).equals('home')
        expect(native.items.map(item => item.testID)).deep.equals([
          'tab-home',
          'tab-videos',
          'tab-schedule',
          'tab-search',
          'tab-chat'
        ])
        expect(
          native.items.filter(item => item.badge).map(item => item.title)
        ).deep.equals(['Chat'])
        const select = native.onSelectTab as (event: {
          nativeEvent: { id: string }
        }) => void
        select({ nativeEvent: { id: 'search' } })
        select({ nativeEvent: { id: 'unknown' } })
        expect(selected).deep.equals(['search'])
        const resize = native.onBarHeight as (event: {
          nativeEvent: { height: number }
        }) => void
        resize({ nativeEvent: { height: 83 } })
        expect(heights).deep.equals([62])
      }
    )
})

describe('the compact and opaque native tab bar', () => {
  it('uses the app colors for the opaque platter and keeps Chat accessible', () => {
    const bar = renderBar(tsBallpark, {
      selected: 'chat',
      mode: 'floating',
      compact: true,
      reduced: true,
      dots: { chat: true },
      onSelect: () => {}
    }).props.children.props
    expect(bar.compact).equals(true)
    expect(bar.opaqueBackgroundColor).equals(
      tsBallpark.navOpaqueBackgroundColor
    )
    expect(bar.activeColor).equals(tsBallpark.navOpaqueActiveColor)
    expect(bar.inactiveColor).equals(tsBallpark.navOpaqueInactiveColor)
    expect(bar.items.find(tab => tab.id === 'chat')).includes({
      title: 'Chat',
      badge: true
    })
  })
})

describe('availability of the system tab bar', () => {
  it('uses UIKit from iOS 26 and limits launch overrides to development builds', () => {
    const supports = (
      version: string | number,
      override: boolean,
      developBuild: boolean,
      debug: boolean
    ): boolean =>
      loadNative(
        'supportsSystemTabBar.ios.ts',
        {
          'react-native': {
            Platform: { Version: version },
            Settings: { get: () => (override ? 'capsule' : undefined) }
          },
          '../platform/developBuild': { developBuild }
        },
        debug
      ).supportsSystemTabBar()
    expect(supports('18.6', false, false, false)).equals(false)
    expect(supports(26, false, false, false)).equals(true)
    expect(supports('27.2', true, false, false)).equals(true)
    expect(supports('27.2', true, true, false)).equals(false)
    expect(supports('27.2', true, false, true)).equals(false)
    expect(supports('27.2', false, true, true)).equals(true)
    expect(
      UnsupportedTabBar({
        selected: 'home',
        mode: 'floating',
        onSelect: () => {}
      })
    ).equals(null)
  })
})
