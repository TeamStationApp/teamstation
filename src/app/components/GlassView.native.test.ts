import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { expect } from 'chai'
import React from 'react'
import { transform } from 'sucrase'

import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { backdropOf } from './glassBackdrop'
import type { GlassViewProps } from './glassViewProps'

/** Execute the native component at its native bridge boundary, with its own source map. */
function nativeGlass(
  platform: 'ios' | 'android' | 'web',
  canBlur = false
): (props: GlassViewProps) => React.ReactElement {
  const source = resolve(
    platform === 'web'
      ? 'src/app/components/GlassView.tsx'
      : 'src/app/components/GlassView.native.tsx'
  )
  const compiled = `${source}.js`
  const transformed = transform(readFileSync(source, 'utf8'), {
    transforms: ['typescript', 'jsx', 'imports'],
    filePath: source,
    sourceMapOptions: { compiledFilename: compiled }
  })
  const loaded = new Module(compiled)
  const dependencies: Record<string, unknown> = {
    react: React,
    'react-native': {
      Platform: { OS: platform },
      View: 'native-view',
      StyleSheet: {
        absoluteFill: {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0
        }
      },
      requireNativeComponent: (name: string) => name,
      processColor: () => 123
    },
    '../theme/ThemeContext': { useTheme: () => tsBallpark },
    '../theme/tsDark': { tsDark },
    './glassBackdrop': { backdropOf },
    './glass': {
      canBlur,
      glassStyle: () => ({ backgroundColor: 'fallback' }),
      webStyle: (style: object) => style
    }
  }
  const map = Buffer.from(JSON.stringify(transformed.sourceMap)).toString(
    'base64'
  )
  loaded.require = (name: string) => {
    if (!(name in dependencies))
      throw new Error(`Unexpected native dependency: ${name}`)
    return dependencies[name]
  }
  ;(
    loaded as unknown as {
      _compile: (code: string, filename: string) => void
    }
  )._compile(
    `${transformed.code}\n//# sourceMappingURL=data:application/json;base64,${map}`,
    compiled
  )
  const exported = loaded.exports as {
    GlassView?: (props: GlassViewProps) => React.ReactElement
  }
  if (exported.GlassView == null)
    throw new Error('Native GlassView export required')
  createRequire(source).cache[compiled] = loaded
  return exported.GlassView
}

describe('GlassView native subtle blur', () => {
  it('keeps web controls filled when backdrop blur is unavailable', () => {
    for (const supported of [false, true]) {
      const Glass = nativeGlass('web', supported)
      const view = Glass({ subtleBlur: true })
      const styles = (view.props as { style: Array<object | undefined> }).style
      expect(styles.at(-1)).deep.equals(
        supported
          ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }
          : { backgroundColor: 'fallback' }
      )
    }
  })
  it('uses transparent Android blur beneath children and keeps ordinary tint intact', () => {
    const Glass = nativeGlass('android')
    const child = React.createElement('label', null, 'Behind a control')
    const subtle = Glass({
      children: child,
      androidBlur: true,
      subtleBlur: true,
      radius: 8
    })
    const ordinary = Glass({ children: child, androidBlur: true, radius: 8 })
    const parts = (element: React.ReactElement): React.ReactElement[] =>
      (element.props as { children: React.ReactElement[] }).children
    const blur = parts(subtle)[0]
    expect(blur.type).equals('TSBlurView')
    expect(blur.props).includes({
      blurRadius: 8,
      blurTint: 0,
      blurSaturation: 1,
      blurCornerRadius: 8
    })
    expect(parts(subtle)[1]).equals(child)
    expect(parts(ordinary)[0].props).includes({ blurTint: 123 })
    expect(
      (
        Glass({ opaque: true, androidBlur: true, subtleBlur: true }).props as {
          children: unknown
        }
      ).children
    ).equals(undefined)
  })
  it('passes the opt-in to iOS without changing default glass or child placement', () => {
    const Glass = nativeGlass('ios')
    const child = React.createElement('label', null, 'Control')
    const subtle = Glass({ children: child, subtleBlur: true, radius: 8 })
    const parts = (subtle.props as { children: React.ReactElement[] }).children
    expect(parts[0].type).equals('TSGlassView')
    expect(parts[0].props).includes({
      glassSubtleBlur: true,
      glassRadius: 8,
      glassBackdropBlur: false
    })
    expect(parts[1]).equals(child)
    const ordinary = Glass({})
    expect(
      (ordinary.props as { children: React.ReactElement[] }).children[0].props
    ).includes({ glassSubtleBlur: false })
    expect(Glass({ opaque: true, subtleBlur: true }).type).equals('native-view')
  })
  it('tints the glass on iOS only, and nowhere else', () => {
    const tint = '#2B42218C'
    const ios = nativeGlass('ios')
    const tinted = (
      ios({ tint, interactive: true }).props as {
        children: React.ReactElement[]
      }
    ).children[0]
    expect(tinted.type).equals('TSGlassView')
    expect(tinted.props).includes({ glassTint: tint, glassInteractive: true })
    const plain = (ios({}).props as { children: React.ReactElement[] })
      .children[0]
    expect((plain.props as { glassTint?: string }).glassTint).equals(undefined)
    // Android draws its fill, blurred or not, and the web its View: neither
    // takes a tint, and neither passes one on.
    for (const [platform, androidBlur] of [
      ['android', false],
      ['android', true],
      ['web', false]
    ] as const) {
      const Glass = nativeGlass(platform)
      const drawn = JSON.stringify(Glass({ tint, androidBlur }))
      expect(drawn, `${platform} ${androidBlur}`).not.includes(tint)
      expect(drawn).equals(JSON.stringify(Glass({ androidBlur })))
    }
  })
  it('draws no material and no fill when bare, keeping the children in their place', () => {
    const child = React.createElement('label', null, 'Back')
    const parts = (element: React.ReactElement): unknown[] =>
      (element.props as { children: unknown[] }).children
    const fills = (element: React.ReactElement): string =>
      JSON.stringify((element.props as { style: unknown }).style)
    // iOS: the material's slot is emptied, never removed.
    const ios = nativeGlass('ios')
    const glass = ios({ children: child })
    const bare = ios({ children: child, bare: true })
    expect(bare.type).equals(glass.type)
    expect(parts(glass)).length(2)
    expect((parts(glass)[0] as React.ReactElement).type).equals('TSGlassView')
    expect(parts(bare)).deep.equals([null, child])
    expect(parts(bare)[1]).equals(parts(glass)[1])
    // Android's blur: the same.
    const android = nativeGlass('android')
    const blurred = android({ children: child, androidBlur: true })
    const bareBlur = android({ children: child, androidBlur: true, bare: true })
    expect((parts(blurred)[0] as React.ReactElement).type).equals('TSBlurView')
    expect(parts(bareBlur)).deep.equals([null, child])
    // Android's fallback: the same view and child, with no fill.
    const filled = android({ children: child, style: { height: 48 } })
    const bareFill = android({
      children: child,
      style: { height: 48 },
      bare: true
    })
    expect(bareFill.type).equals(filled.type)
    expect((bareFill.props as { children: unknown }).children).equals(child)
    expect(fills(filled)).includes('backgroundColor')
    expect(fills(bareFill)).not.includes('backgroundColor')
    expect(fills(bareFill)).not.includes('elevation')
    // The browser: no material.
    const web = nativeGlass('web', true)
    const webBare = web({ children: child, bare: true })
    expect((webBare.props as { children: unknown }).children).equals(child)
    expect(fills(webBare)).not.includes('fallback')
    expect(fills(webBare)).not.includes('blur')
    expect(fills(web({ children: child }))).includes('fallback')
  })
})
