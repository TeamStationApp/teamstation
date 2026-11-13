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
})
