import { type ChildProcess, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { transform } from 'sucrase'

import { userIdOfGumbo } from '../../common/userId'
import {
  asIdentityCompatibility,
  CHAT2_SCENARIOS,
  type Chat2Fixture,
  type Chat2Message,
  fixtureClient
} from '../../test/chat2Fixture.e2e'
import {
  androidCaptureImeState,
  androidClosedCaptureGeometry,
  androidComposerControl,
  androidDismissReference,
  androidImeFrame,
  androidScopedBounds,
  Chat2UI,
  iosPublicRead,
  type PublicNode,
  readAndroidComposerKeyboard
} from '../../test/chat2Maestro.e2e'
import { backdropOf } from '../components/glassBackdrop'
import type { GlassViewProps } from '../components/glassViewProps'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import {
  androidMentionHeaderGeometry,
  compareIosComposerFrames,
  iosMentionHeaderGeometry,
  iosSpotlightCaptureGeometry,
  observeComposerCaptureReady,
  observeInfoCaptureReady,
  observeMentionHeader,
  observeSpotlightCaptureReady,
  Scenarios
} from './chat2.e2e'
import { endsIncomingRun } from './chatMessageRuns'
import { captureMessageBounds } from './chatMessageSource'
import { spotlightLayout } from './chatSpotlightModel'
import { message } from './chatViews.test.helpers'

/** Execute the native component at its native bridge boundary, with its own source map. */
function nativeGlass(
  platform: 'ios' | 'android'
): (props: GlassViewProps) => React.ReactElement {
  const source = resolve('src/app/components/GlassView.native.tsx')
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
    './glassBackdrop': { backdropOf }
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

/** Render the attention surface through the real native material component. */
function nativeAttention(platform: 'ios' | 'android'): {
  surface: React.ReactElement<GlassViewProps>
  rendered: React.ReactElement
} {
  const source = resolve('src/app/chat/ChatAttentionControl.tsx')
  const compiled = `${source}.native-test.js`
  const transformed = transform(readFileSync(source, 'utf8'), {
    transforms: ['typescript', 'jsx', 'imports'],
    filePath: source,
    sourceMapOptions: { compiledFilename: compiled }
  })
  const GlassView = nativeGlass(platform)
  const loaded = new Module(compiled)
  const dependencies: Record<string, unknown> = {
    react: React,
    'react-native': {
      Pressable: 'native-pressable',
      Text: 'native-text',
      View: 'native-view'
    },
    '../components': { Icon: 'native-icon' },
    '../components/GlassView': { GlassView },
    '../locales/strings': {
      lstrings: { chat_latest: 'Latest' },
      sprintf: (text: string) => text
    },
    '../theme/ThemeContext': { useTheme: () => tsBallpark }
  }
  loaded.require = (name: string) => {
    if (!(name in dependencies))
      throw new Error(`Unexpected native attention dependency: ${name}`)
    return dependencies[name]
  }
  const map = Buffer.from(JSON.stringify(transformed.sourceMap)).toString(
    'base64'
  )
  ;(
    loaded as unknown as { _compile: (code: string, filename: string) => void }
  )._compile(
    `${transformed.code}\n//# sourceMappingURL=data:application/json;base64,${map}`,
    compiled
  )
  createRequire(source).cache[compiled] = loaded
  const Control = (
    loaded.exports as {
      ChatAttentionControl: (
        props: Record<string, unknown>
      ) => React.ReactElement
    }
  ).ChatAttentionControl
  const node = Control({
    count: 0,
    loading: false,
    failed: false,
    disabled: false,
    bottom: 12,
    right: 12,
    onLatest: () => {},
    onNext: () => {},
    onRetry: () => {}
  })
  const surface = React.Children.toArray(
    (node.props as { children: React.ReactNode }).children
  ).find(
    child =>
      React.isValidElement<GlassViewProps>(child) && child.type === GlassView
  )
  if (!React.isValidElement<GlassViewProps>(surface))
    throw new Error('Actual native attention glass surface required')
  return { surface, rendered: GlassView(surface.props) }
}

describe('chat attention native circular material', function () {
  it('passes the circular radius to the iOS material behind the48-point hit target', function () {
    const { surface, rendered } = nativeAttention('ios')
    const material = React.Children.toArray(
      (rendered.props as { children: React.ReactNode }).children
    )[0]
    if (!React.isValidElement<{ glassRadius: number }>(material))
      throw new Error('Actual iOS attention material required')
    expect(material.type).equals('TSGlassView')
    expect(material.props.glassRadius).equals(24)
    const target = surface.props.children
    if (
      !React.isValidElement<{ style: { minWidth: number; minHeight: number } }>(
        target
      )
    )
      throw new Error('Actual latest hit target required')
    expect(target.props.style.minWidth).equals(48)
    expect(target.props.style.minHeight).equals(48)
  })

  it('preserves the circular Android filled fallback without creating iOS glass', function () {
    const { surface, rendered } = nativeAttention('android')
    expect((rendered.props as { style: unknown[] }).style).deep.contains({
      position: 'absolute',
      right: 0,
      bottom: 0,
      borderRadius: 24
    })
    expect((rendered.props as { children: React.ReactNode }).children).equals(
      surface.props.children
    )
    expect(
      React.Children.toArray(
        (rendered.props as { children: React.ReactNode }).children
      ).some(
        child => React.isValidElement(child) && child.type === 'TSGlassView'
      )
    ).equals(false)
  })
})

describe('chat native backdrop material boundary', function () {
  it('opts into iOS backdrop blur without changing ordinary glass, child identity or theme', function () {
    const GlassView = nativeGlass('ios')
    const child = React.createElement('span', null, 'Selected message')
    const ordinary = GlassView({ children: child })
    const selected = GlassView({
      children: child,
      backdropBlur: true,
      radius: 24,
      interactive: true,
      dark: true
    })
    const [ordinaryMaterial] = React.Children.toArray(
      (ordinary.props as { children: React.ReactNode }).children
    )
    const [selectedMaterial, selectedChild] = React.Children.toArray(
      (selected.props as { children: React.ReactNode }).children
    )
    expect(React.isValidElement(ordinaryMaterial)).equals(true)
    expect(React.isValidElement(selectedMaterial)).equals(true)
    if (
      !React.isValidElement<{
        glassBackdropBlur: boolean
        glassRadius: number
        glassInteractive: boolean
        glassDark: boolean
      }>(ordinaryMaterial) ||
      !React.isValidElement<{
        glassBackdropBlur: boolean
        glassRadius: number
        glassInteractive: boolean
        glassDark: boolean
      }>(selectedMaterial)
    )
      throw new Error('Actual native material required')
    expect(ordinaryMaterial.type).equals('TSGlassView')
    expect(ordinaryMaterial.props.glassBackdropBlur).equals(false)
    expect(selectedMaterial.props.glassBackdropBlur).equals(true)
    expect(selectedMaterial.props.glassRadius).equals(24)
    expect(selectedMaterial.props.glassInteractive).equals(true)
    expect(selectedMaterial.props.glassDark).equals(true)
    expect(
      React.isValidElement(selectedChild) && selectedChild.props
    ).deep.equals(child.props)
    const opaque = GlassView({
      children: child,
      backdropBlur: true,
      opaque: true
    })
    expect((opaque.props as { children: React.ReactNode }).children).equals(
      child
    )
    expect((opaque.props as { style: unknown[] }).style).deep.contains({
      backgroundColor: tsBallpark.glassFallbackColor,
      elevation: 0
    })
  })

  it('preserves Android blur and filled fallback when the iOS opt-in is supplied', function () {
    const GlassView = nativeGlass('android')
    const fallback = GlassView({ backdropBlur: true })
    expect((fallback.props as { style: unknown[] }).style).deep.contains({
      backgroundColor: tsBallpark.glassFallbackColor,
      elevation: 3
    })
    const blurred = GlassView({
      backdropBlur: true,
      androidBlur: true,
      radius: 18
    })
    const [material] = React.Children.toArray(
      (blurred.props as { children: React.ReactNode }).children
    )
    if (
      !React.isValidElement<{
        blurRadius: number
        blurCornerRadius: number
        glassBackdropBlur?: boolean
      }>(material)
    )
      throw new Error('Actual Android material required')
    expect(material.type).equals('TSBlurView')
    expect(material.props.blurRadius).equals(
      backdropOf(tsBallpark.glassBlur).radius
    )
    expect(material.props.blurCornerRadius).equals(18)
    expect(material.props.glassBackdropBlur).equals(undefined)
  })
})

const base = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  safe: { top: 44, right: 0, bottom: 34, left: 0 },
  preview: 120,
  panel: 224,
  reactions: 48,
  gap: 8,
  maxWidth: 448,
  mine: false
}

describe('chat sender runs and spotlight bounds', function () {
  it('reserves an incoming run until its final bubble and breaks at notices, dates, authors and outgoing posts', function () {
    const messages = [
      message({ id: 'msg_a' }),
      message({ id: 'msg_b' }),
      message({ id: 'msg_c', senderUserId: userIdOfGumbo(3) }),
      message({ id: 'msg_d', senderUserId: userIdOfGumbo(3), mine: true }),
      message({ id: 'msg_e' }),
      message({ id: 'msg_f', sentAt: '2027-04-02T17:00:00.000Z' })
    ]
    expect(
      messages.map((_value, index) => endsIncomingRun(messages, index))
    ).deep.equals([false, true, true, false, true, true])
    expect(endsIncomingRun(messages, 0, true)).equals(true)
    expect(endsIncomingRun([], 0)).equals(false)
  })

  it('keeps long previews and all action controls inside the keyboard and safe areas', function () {
    for (const mine of [true, false]) {
      const result = spotlightLayout({
        ...base,
        mine,
        keyboardTop: 470,
        preview: 2400,
        panel: 800,
        source: { x: mine ? 180 : 22, y: 650, width: 170, height: 2000 }
      })
      expect(result.left).at.least(8)
      expect(result.left + result.width).at.most(382)
      expect(result.top).at.least(52)
      expect(result.top + result.panelTop + result.panel).at.most(462)
      expect(result.preview).greaterThan(0).and.lessThan(2400)
      expect(result.panel).greaterThan(44).and.lessThan(800)
      expect(result.animateSource).equals(false)
      expect(result.sourceY).equals(0)
    }
  })

  it('uses window-relative sources inside an offset pane and makes room for no reaction strip', function () {
    const result = spotlightLayout({
      ...base,
      frame: { x: 100, y: 48, width: 290, height: 600 },
      safe: { top: 0, right: 8, bottom: 20, left: 8 },
      reactions: 0,
      source: { x: 120, y: 100, width: 180, height: 120 }
    })
    expect(result.left).equals(16)
    expect(result.previewTop).equals(0)
    expect(result.top).equals(52)
    expect(result.sourceX).equals(4)
    expect(result.sourceY).equals(0)
    expect(result.animateSource).equals(true)
  })

  it('centers a fade fallback without an origin and bounds very small viewports', function () {
    const result = spotlightLayout(base)
    expect(result.left).equals(8)
    expect(result.sourceX).equals(0)
    expect(result.sourceY).equals(0)
    const small = spotlightLayout({
      ...base,
      frame: { x: 0, y: 0, width: 200, height: 180 },
      safe: { top: 8, right: 0, bottom: 8, left: 0 },
      keyboardTop: 160
    })
    expect(small.top + small.panelTop + small.panel).at.most(152)
    expect(small.width).equals(184)
  })

  it('gives short reading bands to one scroll panel without any overflow, including zero and large text', function () {
    for (const available of [0, 1, 8, 44, 48, 64, 96, 128, 180]) {
      for (const minimumPanel of [44, 96]) {
        const result = spotlightLayout({
          ...base,
          frame: { x: 80, y: 40, width: 320, height: 600 },
          safe: { top: 12, right: 4, bottom: 20, left: 4 },
          keyboardTop: 40 + 12 + available,
          source: { x: 100, y: 500, width: 200, height: 1000 },
          preview: 2000,
          panel: 800,
          minimumPanel
        })
        expect(result.top).at.least(12)
        expect(result.top + result.panelTop + result.panel).at.most(
          12 + available
        )
        expect(result.preview).at.least(0)
        expect(result.panel).at.least(0)
        if (available <= 96) {
          expect(result.compact).equals(true)
          expect(result.preview).equals(0)
          expect(result.reactions).equals(0)
          expect(result.panelTop).equals(0)
          expect(result.panel).equals(available)
        }
      }
    }
    const exhausted = spotlightLayout({
      ...base,
      frame: { x: 0, y: 0, width: 0, height: 0 },
      safe: { top: 0, right: 0, bottom: 0, left: 0 },
      keyboardTop: -20
    })
    expect(exhausted.width).equals(0)
    expect(exhausted.top + exhausted.panelTop + exhausted.panel).equals(0)
  })

  it('fades clipped tall, horizontal and keyboard-obscured origins instead of flying in from invisible content', function () {
    const frame = { x: 100, y: 40, width: 320, height: 600 }
    const options = {
      ...base,
      frame,
      safe: { top: 20, right: 8, bottom: 16, left: 8 },
      keyboardTop: 500
    }
    for (const source of [
      { x: 120, y: -2000, width: 180, height: 2400 },
      { x: 120, y: 400, width: 180, height: 180 },
      { x: 90, y: 100, width: 180, height: 120 },
      { x: 300, y: 100, width: 180, height: 120 }
    ]) {
      const result = spotlightLayout({ ...options, source })
      expect(result.animateSource).equals(false)
      expect(result.sourceX).equals(0)
      expect(result.sourceY).equals(0)
      expect(result.top).at.least(20)
      expect(result.top + result.panelTop + result.panel).at.most(460)
    }
    const visible = spotlightLayout({
      ...options,
      source: { x: 120, y: 100, width: 180, height: 120 }
    })
    expect(visible.animateSource).equals(true)
  })
})

describe('chat cancellable bubble measurements', function () {
  it('accepts one finite source and ignores duplicate callbacks', function () {
    const values: unknown[] = []
    captureMessageBounds(
      {
        measureInWindow: accept => {
          accept(20, 30, 180, 120)
          accept(0, 0, 1, 1)
        }
      },
      () => true,
      bounds => values.push(bounds)
    )()
    expect(values).deep.equals([{ x: 20, y: 30, width: 180, height: 120 }])
  })

  it('fades for detached, zero-sized, nonfinite and invalidated sources', function () {
    for (const coordinates of [
      [0, 0, 0, 100],
      [NaN, 0, 20, 30],
      [0, 0, 10, -1]
    ]) {
      let received: unknown = 'pending'
      captureMessageBounds(
        {
          measureInWindow: accept => {
            accept(...(coordinates as [number, number, number, number]))
          }
        },
        () => true,
        value => {
          received = value
        }
      )
      expect(received).equals(undefined)
    }
    let received: unknown = 'pending'
    captureMessageBounds(
      null,
      () => true,
      value => {
        received = value
      }
    )
    expect(received).equals(undefined)
    captureMessageBounds(
      {
        measureInWindow: accept => {
          accept(0, 0, 20, 30)
        }
      },
      () => false,
      value => {
        received = value
      }
    )
    expect(received).equals(undefined)
  })

  it('bounds a missing native callback and cancels late callbacks after a scroll or unmount', async function () {
    let deliver:
      | ((x: number, y: number, width: number, height: number) => void)
      | undefined
    const values: unknown[] = []
    const cancel = captureMessageBounds(
      {
        measureInWindow: accept => {
          deliver = accept
        }
      },
      () => true,
      value => values.push(value)
    )
    cancel()
    deliver?.(0, 0, 20, 30)
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(values).deep.equals([])
    captureMessageBounds(
      { measureInWindow: () => {} },
      () => true,
      value => values.push(value)
    )
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(values).deep.equals([undefined])
  })
})

// Neutral synthetic native metadata; no captured device hierarchy is embedded.
type CaptureBox = NonNullable<PublicNode['bounds']>
interface CaptureNode {
  index: number
  type: string
  identifier?: string
  label?: string
  rect: CaptureBox
  parentIndex?: number
}
const selectedMessage = { id: 'msg_preview', body: 'Practice reminder' }
const captureImages = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGD4DwABCAEBfBRbtQAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYmD4DwABDAECkQ7bWQAAAABJRU5ErkJggg=='
].map(encoded => Buffer.from(encoded, 'base64'))
const captureJpegs = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCegFAH/9k=',
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCDgKAP/9k='
].map(encoded => Buffer.from(encoded, 'base64'))
function composerPng(
  rectangles: Array<{ box: number[]; color: number[] }> = [],
  scale = 1
): Buffer {
  const result = spawnSync(
    process.env.CHAT2_PYTHON ?? 'python3',
    [
      '-c',
      `import sys,json
from PIL import Image,ImageDraw
p=json.loads(sys.argv[1]); s=p['scale']
im=Image.new('RGBA',(400*s,800*s),(250,250,250,255)); draw=ImageDraw.Draw(im)
for shape in p['rectangles']:
 x,y,w,h=shape['box']; draw.rectangle((x*s,y*s,(x+w)*s-1,(y+h)*s-1),fill=tuple(shape['color']))
im.save(sys.stdout.buffer,format='PNG')`,
      JSON.stringify({ rectangles, scale })
    ],
    { timeout: 10000 }
  )
  expect(result.status, String(result.stderr)).equals(0)
  return result.stdout
}
function selectedHierarchy(): { nodes: CaptureNode[] } {
  const preview = { x: 20, y: 180, width: 240, height: 80 }
  const text = { x: 32, y: 206, width: 216, height: 24 }
  return {
    nodes: [
      {
        index: 1,
        type: 'Other',
        identifier: 'chat-message-spotlight',
        rect: { x: 0, y: 0, width: 400, height: 800 }
      },
      {
        index: 2,
        type: 'Other',
        identifier: 'chat-message-spotlight-controls',
        parentIndex: 1,
        rect: { x: 20, y: 120, width: 320, height: 320 }
      },
      {
        index: 3,
        type: 'Other',
        identifier: 'chat-message-spotlight-preview',
        parentIndex: 1,
        rect: { ...preview }
      },
      { index: 4, type: 'ScrollView', parentIndex: 3, rect: { ...preview } },
      {
        index: 5,
        type: 'Other',
        identifier: 'chat-bubble-' + selectedMessage.id,
        parentIndex: 4,
        rect: { ...preview }
      },
      {
        index: 6,
        type: 'Other',
        label: selectedMessage.body,
        parentIndex: 5,
        rect: { ...text }
      },
      {
        index: 7,
        type: 'StaticText',
        label: selectedMessage.body,
        parentIndex: 6,
        rect: { ...text }
      },
      {
        index: 8,
        type: 'Other',
        identifier: 'chat-message-spotlight-panel',
        parentIndex: 1,
        rect: { x: 20, y: 270, width: 320, height: 170 }
      }
    ]
  }
}
function selectedVariant(mode: string): { nodes: CaptureNode[] } {
  const raw = selectedHierarchy()
  const preview = raw.nodes[2]
  const scroll = raw.nodes[3]
  const bubble = raw.nodes[4]
  const body = raw.nodes[6]
  if (mode === 'missing-body' || mode === 'wrapper-only')
    raw.nodes = raw.nodes.filter(node => node !== body)
  if (mode === 'missing-preview')
    raw.nodes = raw.nodes.filter(node => node !== preview)
  if (mode === 'zero-scroll') scroll.rect.height = 0
  if (mode === 'zero-preview') preview.rect.height = 0
  if (mode === 'outside-body') body.rect.y = 500
  if (mode === 'wrong-bubble') bubble.identifier = 'chat-bubble-other'
  if (mode === 'outside-ancestry') body.parentIndex = 1
  if (mode === 'duplicate-body') raw.nodes.push({ ...body, index: 9 })
  if (mode === 'cycle') body.parentIndex = body.index
  if (mode === 'invalid-number') body.rect.width = NaN
  if (mode === 'tall') body.rect.height = 300
  if (mode === 'compact') {
    raw.nodes[7].rect = { ...raw.nodes[1].rect }
    raw.nodes = raw.nodes.filter(node => node !== preview)
  }
  return raw
}
const rawBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
interface CaptureSample {
  ready?: boolean
  rawPairStable?: boolean
  rawPairStableForMs?: number
  rawFrames?: Array<{
    sha256: string
    path: string
    at?: string
    width?: number
    height?: number
    comparedWith?: string
    comparison?: {
      accepted: boolean
      reason: string
      diffBounds: number[]
    }
  }>
  image?: { sha256: string }
  publicAccessibility?: {
    positiveComposerKeyboard?: boolean
    focusSignal?: string
    focused?: boolean
    keyboard?: boolean
    reply?: boolean
  }
  selected?: { compact: boolean }
}
interface CaptureObservation {
  outcome: string
  samples: CaptureSample[]
  failureArtifacts?: Array<{ path: string }>
}
const captureObservation = (ui: Chat2UI): CaptureObservation =>
  ui.steps[0] as unknown as CaptureObservation
async function captureFailure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
  } catch (error) {
    return error
  }
  throw new Error('Expected capture readiness to fail')
}

describe('chat capture selected-clone ancestry', function () {
  it('uses the actual StaticText under the selected bubble and ignores the repeated wrapper label', function () {
    const actual = iosSpotlightCaptureGeometry(
      rawBytes(selectedHierarchy()),
      selectedMessage
    )
    expect(actual.compact).equals(false)
    expect(actual.bodyApplicable).equals(true)
    expect(actual.geometry.body).deep.equals({
      x: 32,
      y: 206,
      width: 216,
      height: 24
    })
  })
  for (const mode of [
    'missing-body',
    'wrapper-only',
    'missing-preview',
    'zero-scroll',
    'zero-preview',
    'outside-body',
    'wrong-bubble',
    'outside-ancestry',
    'duplicate-body',
    'cycle',
    'invalid-number'
  ])
    it(
      'rejects selected ' +
        mode +
        ' instead of accepting only the actions panel',
      function () {
        expect(() =>
          iosSpotlightCaptureGeometry(
            rawBytes(selectedVariant(mode)),
            selectedMessage
          )
        ).throws()
      }
    )
  it('accepts a visible slice of taller scrollable text without requiring the whole body on screen', function () {
    expect(
      iosSpotlightCaptureGeometry(
        rawBytes(selectedVariant('tall')),
        selectedMessage
      ).bodyApplicable
    ).equals(true)
  })
  it('permits absent preview only for the observed panel filling its whole controls band', function () {
    const actual = iosSpotlightCaptureGeometry(
      rawBytes(selectedVariant('compact')),
      selectedMessage
    )
    expect(actual.compact).equals(true)
    expect(actual.bodyApplicable).equals(false)
    expect(actual.geometry).has.keys('controls', 'panel')
  })
  it('does not invent text proof for an empty-body attachment preview', function () {
    const actual = iosSpotlightCaptureGeometry(
      rawBytes(selectedVariant('missing-body')),
      { ...selectedMessage, body: '' }
    )
    expect(actual.compact).equals(false)
    expect(actual.bodyApplicable).equals(false)
    expect(actual.geometry).not.has.property('body')
  })
})

describe('chat native capture readiness transport', function () {
  const temporary: string[] = []
  afterEach(function () {
    for (const path of temporary.splice(0))
      rmSync(path, { recursive: true, force: true })
  })
  const directory = (): string => {
    const path = mkdtempSync(join(tmpdir(), 'chat-capture-'))
    temporary.push(path)
    return path
  }
  const caret = (
    box = [110, 455, 2, 26],
    color = [66, 107, 242, 255]
  ): { box: number[]; color: number[] } => ({
    box,
    color
  })
  function compareFrames(
    before: Buffer,
    after: Buffer,
    composer = { x: 100, y: 450, width: 220, height: 40 },
    viewport = { width: 400, height: 800 }
  ): Record<string, unknown> {
    const dir = directory()
    const previous = join(dir, 'before.raw.png')
    const current = join(dir, 'after.raw.png')
    writeFileSync(previous, before)
    writeFileSync(current, after)
    const result = compareIosComposerFrames({
      previous,
      current,
      composer,
      viewport,
      timeout: 10000
    })
    expect(readFileSync(previous).equals(before)).equals(true)
    expect(readFileSync(current).equals(after)).equals(true)
    return result
  }
  for (const scale of [1, 2, 3])
    it(
      'accepts only the blue caret stripe at actual raster scale' + scale,
      function () {
        const actual = compareFrames(
          composerPng([caret(undefined, [110, 142, 242, 255])], scale),
          composerPng([caret()], scale)
        )
        expect(actual.accepted).equals(true)
        expect(actual.scale).equals(scale)
        expect(actual.changedPixels).equals(2 * 26 * scale * scale)
        expect(actual.diffBounds).deep.equals([
          110 * scale,
          455 * scale,
          112 * scale,
          481 * scale
        ])
      }
    )
  it('binds a larger-text caret height to the measured editable field', function () {
    const actual = compareFrames(
      composerPng(),
      composerPng([caret([110, 455, 2, 60])]),
      { x: 100, y: 450, width: 220, height: 80 }
    )
    expect(actual.accepted).equals(true)
  })
  it('accepts blue caret interpolation over dark glyph ink in either blink direction', function () {
    const before = composerPng([
      caret(undefined, [110, 142, 242, 255]),
      caret([110, 461, 2, 8], [26, 33, 22, 255])
    ])
    const after = composerPng([
      caret(),
      caret([110, 461, 2, 8], [46, 70, 132, 255])
    ])
    for (const [a, b] of [
      [before, after],
      [after, before]
    ]) {
      const actual = compareFrames(a, b)
      expect(actual.accepted).equals(true)
      expect(actual.invalidCaretPixels).equals(0)
      expect(actual.strongBluePixels).greaterThan(0)
    }
  })
  it('rejects a non-caret color change even inside a narrow blue stripe', function () {
    const before = composerPng([
      caret(undefined, [110, 142, 242, 255]),
      caret([110, 461, 2, 8], [26, 33, 22, 255])
    ])
    const after = composerPng([
      caret(),
      caret([110, 461, 2, 8], [46, 170, 132, 255])
    ])
    const actual = compareFrames(before, after)
    expect(actual.accepted).equals(false)
    expect(actual.invalidCaretPixels).greaterThan(0)
  })
  for (const [name, shapes] of [
    ['status clock', [caret(), caret([10, 10, 8, 12], [0, 0, 0, 255])]],
    ['outside field', [caret([98, 455, 2, 26])]],
    ['too wide', [caret([110, 455, 6, 26])]],
    ['letter fade', [caret([110, 455, 2, 26], [20, 20, 20, 255])]],
    ['control fade', [caret([330, 455, 40, 40])]],
    ['field fade', [caret([100, 450, 220, 40], [230, 230, 230, 255])]],
    ['clipped caret', [caret([110, 480, 2, 26])]],
    ['alpha change', [caret([110, 455, 2, 26], [66, 107, 242, 100])]],
    ['disconnected stripes', [caret([110, 455, 2, 8]), caret([110, 470, 2, 8])]]
  ] as const)
    it('rejects whole-frame ' + name + ' changes', function () {
      const actual = compareFrames(composerPng(), composerPng([...shapes]))
      expect(actual.accepted).equals(false)
    })
  it('rejects moved carets, changed rasters and unproved coordinate scales', function () {
    expect(
      compareFrames(
        composerPng([caret()]),
        composerPng([caret([116, 455, 2, 26])])
      ).accepted
    ).equals(false)
    expect(() => compareFrames(composerPng(), composerPng([], 2))).throws(
      'Unchanged native raster'
    )
    expect(() =>
      compareFrames(composerPng(), composerPng([caret()]), undefined, {
        width: 500,
        height: 800
      })
    ).throws('Actual uniform native raster scale')
  })
  function spotlight(mode: string): { ui: Chat2UI; shots: () => number } {
    let reads = 0
    let shots = 0
    const ui = {
      surface: 'ios',
      native: true,
      runDir: directory(),
      steps: [],
      present: async (id: string) => {
        expect(id).equals('chat-message-spotlight')
      },
      publicBounds: async () => {
        throw new Error('No clipboard bounds fallback')
      },
      device: {
        hierarchyRaw: async ({ signal }: { signal: AbortSignal }) => {
          expect(signal).instanceOf(AbortSignal)
          reads += 1
          if (mode === 'transport')
            throw new Error('Hierarchy transport disconnected')
          return rawBytes(
            selectedVariant(
              mode === 'appearing' && reads < 3 ? 'missing-body' : mode
            )
          )
        },
        screenshot: async ({ signal }: { signal: AbortSignal }) => {
          expect(signal).instanceOf(AbortSignal)
          shots += 1
          return captureImages[mode === 'changing-image' ? shots % 2 : 0]
        },
        copyTextFrom: async () => {
          throw new Error('No clipboard mutation')
        },
        tapOn: async () => {
          throw new Error('No input mutation')
        },
        inputText: async () => {
          throw new Error('No input mutation')
        }
      }
    } as unknown as Chat2UI
    return { ui, shots: () => shots }
  }
  for (const mode of ['stable', 'appearing', 'compact'])
    it(
      'requires selected ' + mode + ' geometry and unchanged raw whole frames',
      async function () {
        const { ui, shots } = spotlight(mode)
        const actual = await observeSpotlightCaptureReady(
          ui,
          1500,
          selectedMessage
        )
        expect(actual.spotlightCaptureReady).equals(true)
        expect(captureObservation(ui).samples.at(-1)?.selected?.compact).equals(
          mode === 'compact'
        )
        expect(shots()).at.least(5)
      }
    )
  for (const mode of [
    'missing-body',
    'missing-preview',
    'zero-scroll',
    'changing-image'
  ])
    it(
      'rejects ' +
        mode +
        ' and retains its actual last hierarchy and image bytes',
      async function () {
        const { ui } = spotlight(mode)
        expect(
          String(
            await captureFailure(
              observeSpotlightCaptureReady(ui, 270, selectedMessage)
            )
          )
        ).contains('Timed out')
        const observation = captureObservation(ui)
        expect(observation.outcome).equals('failed')
        expect(observation.failureArtifacts).length(2)
        const hierarchy = observation.failureArtifacts!.find(row =>
          row.path.endsWith('hierarchy.raw.json')
        )!
        const image = observation.failureArtifacts!.find(row =>
          row.path.endsWith('image.raw.png')
        )!
        expect(
          readFileSync(hierarchy.path).equals(rawBytes(selectedVariant(mode)))
        ).equals(true)
        expect(
          captureImages.some(bytes => bytes.equals(readFileSync(image.path)))
        ).equals(true)
      }
    )
  it('propagates raw hierarchy failure without inventing an image or readiness', async function () {
    const { ui, shots } = spotlight('transport')
    expect(
      String(
        await captureFailure(
          observeSpotlightCaptureReady(ui, 8000, selectedMessage)
        )
      )
    ).contains('disconnected')
    expect(shots()).equals(0)
    expect(captureObservation(ui).outcome).equals('failed')
  })

  async function withSlowMetadata(work: () => Promise<void>): Promise<void> {
    const actualNow = Date.now
    let offset = 0
    Date.now = () => actualNow() + offset
    try {
      modeledAdvance = ms => {
        offset += ms
      }
      await work()
    } finally {
      Date.now = actualNow
      modeledAdvance = () => {}
    }
  }
  let modeledAdvance: (ms: number) => void = () => {}
  function composer(mode: string): {
    ui: Chat2UI
    calls: string[]
    probes: () => number
  } {
    const calls: string[] = []
    let probes = 0
    let shots = 0
    const blinkFrames = ['caret', 'retry-motion'].includes(mode)
      ? [composerPng(), composerPng([caret()])]
      : undefined
    const motionFrame =
      mode === 'retry-motion'
        ? composerPng([caret([10, 10, 8, 12], [0, 0, 0, 255])])
        : undefined
    const history = { x: 0, y: 0, width: 400, height: 800 }
    const band = { x: 20, y: 400, width: 360, height: 100 }
    const input = { x: 100, y: 450, width: 220, height: 40 }
    const keyboard = { x: 0, y: 560, width: 400, height: 240 }
    const buttons: Record<string, CaptureBox> = {
      Attach: { x: 24, y: 450, width: 44, height: 44 },
      Send: { x: 332, y: 450, width: 44, height: 44 },
      'Cancel reply': { x: 344, y: 410, width: 24, height: 24 }
    }
    const ui = {
      surface: 'ios',
      native: true,
      runDir: directory(),
      steps: [],
      device: {
        hierarchy: async ({ signal }: { signal: AbortSignal }) => {
          expect(signal).instanceOf(AbortSignal)
          probes += 1
          modeledAdvance(
            ['retry-motion', 'slow-screenshot'].includes(mode) ? 1000 : 31000
          )
          calls.push('metadata')
          if (mode === 'lost-keyboard' && probes > 1)
            throw new Error('Positive Keyboard lost')
          const moved = mode === 'geometry-change' && probes % 2 === 0 ? 8 : 0
          const nodes: PublicNode[] = [
            { type: 'Keyboard', bounds: keyboard },
            ...Object.entries({
              'chat-message-history': history,
              'chat-composer-band': band,
              'chat-composer': input
            }).map(([id, box]) => ({
              id,
              enabled: true,
              bounds: { ...box, y: box.y + moved }
            }))
          ]
          if (mode === 'overlay' && probes > 1)
            nodes.push({ id: 'chat-message-spotlight', bounds: band })
          return { nodes }
        },
        assertVisible: async (
          args: Record<string, unknown>,
          { signal }: { signal: AbortSignal }
        ) => {
          expect(signal).instanceOf(AbortSignal)
          expect(args.focused).equals(undefined)
          calls.push('control')
          if (mode === 'transport')
            throw new Error('Control transport disconnected')
          if (
            mode === 'lost-reply' &&
            probes > 1 &&
            args.text === 'Cancel reply'
          )
            throw Object.assign(new Error('Absent'), { code: 'COMMAND_FAILED' })
          if (typeof args.id === 'string')
            return {
              element: {
                id: args.id,
                enabled: true,
                bounds: args.id === 'chat-composer' ? input : band
              }
            }
          const text = String(args.text)
          if (!(text in buttons))
            throw new Error('Unexpected public control query')
          return {
            element: {
              text:
                mode === 'wrong-button' && probes > 1 ? 'Other ' + text : text,
              class: 'Button',
              enabled: true,
              bounds: buttons[text]
            }
          }
        },
        screenshot: async ({ signal }: { signal: AbortSignal }) => {
          expect(signal).instanceOf(AbortSignal)
          expect(signal.aborted).equals(false)
          shots += 1
          modeledAdvance(mode === 'retry-motion' && probes === 1 ? 1100 : 100)
          calls.push('image')
          if (mode === 'image-transport')
            throw new Error('Image transport disconnected')
          if (mode === 'slow-screenshot' && shots === 1)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 2100)
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  reject(signal.reason)
                },
                { once: true }
              )
            })
          if (blinkFrames != null) {
            if (mode === 'retry-motion' && probes === 1)
              return shots % 2 === 0 ? blinkFrames[0] : motionFrame!
            return blinkFrames[shots % 2]
          }
          return captureImages[
            mode === 'moving-pixels' ? shots % 2 : probes % 2
          ]
        },
        platformInfo: async ({ signal }: { signal: AbortSignal }) => {
          expect(signal.aborted).equals(false)
          return { screenWidth: 400, screenHeight: 800 }
        },
        tapOn: async () => {
          throw new Error('No input mutation')
        },
        inputText: async () => {
          throw new Error('No input mutation')
        },
        copyTextFrom: async () => {
          throw new Error('No clipboard mutation')
        },
        launchApp: async () => {
          throw new Error('No launch')
        }
      }
    } as unknown as Chat2UI
    return { ui, calls, probes: () => probes }
  }
  it('pairs adjacent equal whole frames around two31-second metadata probes within the90-second budget', async function () {
    await withSlowMetadata(async () => {
      const { ui, calls, probes } = composer('stable')
      const before = Date.now()
      expect(
        (await observeComposerCaptureReady(ui, { focused: true, reply: true }))
          .composerCaptureReady
      ).equals(true)
      expect(Date.now() - before)
        .greaterThan(62000)
        .and.lessThan(90000)
      expect(probes()).equals(2)
      expect(calls).deep.equals([
        'metadata',
        'control',
        'control',
        'control',
        'image',
        'image',
        'metadata',
        'control',
        'control',
        'control',
        'image',
        'image'
      ])
      const observation = captureObservation(ui)
      expect(observation.samples).length(2)
      expect(observation.samples[0].image?.sha256).not.equals(
        observation.samples[1].image?.sha256
      )
      for (const sample of observation.samples) {
        expect(sample.rawPairStable).equals(true)
        expect(sample.rawPairStableForMs).at.least(200)
        expect(sample.rawFrames).length(2)
        expect(sample.rawFrames![0].sha256).equals(sample.rawFrames![1].sha256)
        expect(sample.publicAccessibility?.positiveComposerKeyboard).equals(
          true
        )
        expect(sample.publicAccessibility?.focusSignal).equals(
          'unavailable-on-ios'
        )
      }
      expect(JSON.stringify(ui.steps))
        .not.contains('base64')
        .and.not.contains('data:image')
    })
  })
  it('retains unmodified blinking-caret frame pairs after two fresh positive probes', async function () {
    await withSlowMetadata(async () => {
      const { ui, probes } = composer('caret')
      expect(
        (await observeComposerCaptureReady(ui, { focused: true, reply: true }))
          .composerCaptureReady
      ).equals(true)
      expect(probes()).equals(2)
      for (const sample of captureObservation(ui).samples) {
        expect(sample.rawPairStable).equals(true)
        expect(sample.rawFrames).length(2)
        const frames = sample.rawFrames!
        expect(frames[0].sha256).not.equals(frames[1].sha256)
        expect(frames[1].comparison?.accepted).equals(true)
        for (const frame of frames) {
          const bytes = readFileSync(frame.path)
          expect(
            [composerPng(), composerPng([caret()])].some(png =>
              png.equals(bytes)
            )
          ).equals(true)
        }
      }
    })
  })
  it('allows an in-flight raw capture to finish beyond its normal2-second burst without aborting90-second readiness', async function () {
    await withSlowMetadata(async () => {
      const { ui, probes } = composer('slow-screenshot')
      expect(
        (await observeComposerCaptureReady(ui, { focused: true, reply: true }))
          .composerCaptureReady
      ).equals(true)
      expect(probes()).equals(3)
      expect(captureObservation(ui).samples[0].rawPairStable).equals(false)
    })
  })
  it('retries an unstable burst and still requires two matching fresh positive probes', async function () {
    await withSlowMetadata(async () => {
      const { ui, probes } = composer('retry-motion')
      expect(
        (await observeComposerCaptureReady(ui, { focused: true, reply: true }))
          .composerCaptureReady
      ).equals(true)
      expect(probes()).equals(3)
      const samples = captureObservation(ui).samples
      expect(samples[0].rawPairStable).equals(false)
      expect(samples.slice(1).map(sample => sample.rawPairStable)).deep.equals([
        true,
        true
      ])
    })
  })
  it('requires exact frames when focused positive keyboard proof was not requested', async function () {
    await withSlowMetadata(async () => {
      const { ui } = composer('caret')
      await captureFailure(
        observeComposerCaptureReady(ui, { focused: false, reply: true })
      )
      for (const sample of captureObservation(ui).samples) {
        expect(sample.rawPairStable).not.equals(true)
        for (const frame of sample.rawFrames ?? [])
          expect(frame.comparison).equals(undefined)
      }
    })
  })
  for (const mode of [
    'moving-pixels',
    'geometry-change',
    'overlay',
    'lost-reply',
    'lost-keyboard',
    'wrong-button',
    'transport',
    'image-transport'
  ])
    it(
      'rejects capture ' + mode + ' despite successful unrelated commands',
      async function () {
        await withSlowMetadata(async () => {
          const { ui } = composer(mode)
          await captureFailure(
            observeComposerCaptureReady(ui, { focused: true, reply: true })
          )
          expect(captureObservation(ui).outcome).equals('failed')
          expect(
            captureObservation(ui).samples.every(
              sample =>
                sample.rawFrames == null || sample.rawFrames.length <= 12
            )
          ).equals(true)
        })
      }
    )
})

describe('chat native adapter compatibility', function () {
  this.timeout(10000)
  const box = { x: 10, y: 20, width: 200, height: 40 }
  const node = (
    index: number,
    type: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    index,
    type,
    enabled: true,
    rect: box,
    ...extra
  })
  const raw = (nodes: unknown[]): Buffer =>
    Buffer.from(JSON.stringify({ nodes }))
  const directories: string[] = []
  const browserDocuments: JSDOM[] = []
  afterEach(() => {
    for (const browser of browserDocuments.splice(0)) browser.window.close()
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true })
  })
  function ui(nodes: unknown[], surface = 'ios'): Chat2UI {
    const path = mkdtempSync(join(tmpdir(), 'chat-adapter-'))
    directories.push(path)
    return Object.assign(Object.create(Chat2UI.prototype), {
      surface,
      native: surface !== 'web-wide',
      runDir: path,
      steps: [],
      metrics: () => ({ width: 300, height: 600 }),
      device: {
        hierarchy: async () => ({ nodes }),
        hierarchyRaw: async () => raw(nodes),
        platformInfo: async () => ({ screenWidth: 300, screenHeight: 600 })
      }
    }) as Chat2UI
  }
  function browserModel(): { actual: Chat2UI; page: JSDOM } {
    const actual = ui([], 'web-wide')
    const page = new JSDOM('<!doctype html><body></body>', {
      url: 'https://fixture.example.test/chat',
      runScripts: 'outside-only'
    })
    browserDocuments.push(page)
    Object.defineProperties(page.window, {
      innerWidth: { value: 300 },
      innerHeight: { value: 600 }
    })
    Object.defineProperty(page.window, 'isSecureContext', { value: true })
    page.window.document.hasFocus = () => true
    Object.assign(actual, {
      fixture: { webUrl: 'https://fixture.example.test' },
      deadline: AbortSignal.timeout(10000)
    })
    actual.device.evalBrowserScript = async args => ({
      data: await page.window.eval('(async()=>{' + String(args.script) + '})()')
    })
    return { actual, page }
  }
  async function infoSafetyReturn(fault = ''): Promise<{
    calls: string[]
    error: unknown
  }> {
    const { actual, page } = browserModel()
    const directory = mkdtempSync(join(tmpdir(), 'chat-info-return-'))
    directories.push(directory)
    const sessionFile = join(directory, 'session.json')
    writeFileSync(sessionFile, JSON.stringify({ token: 'TEST_TOKEN' }), {
      mode: 0o600
    })
    Object.assign(actual, { surface: 'web-narrow' })
    const viewerId = userIdOfGumbo(7)
    const memberId = userIdOfGumbo(8)
    const calls: string[] = []
    let stack = ['conversation']
    let safety = false
    let legacy = false
    let draft = ''
    let muted = false
    const render = (): void => {
      page.window.document.body.replaceChildren()
      if (stack.at(-1) !== 'conversation') return
      const editor = page.window.document.createElement('textarea')
      editor.dataset.testid = 'chat-composer'
      editor.value = draft
      page.window.document.body.append(editor)
    }
    page.window.addEventListener('popstate', () => {
      expect(page.window.location.pathname).equals('/chat/cnv-group/members')
      legacy = true
      stack = ['conversation', 'members']
      calls.push('open-members')
      render()
    })
    actual.replaceDraft = async value => {
      draft = value
      render()
    }
    actual.shot = async () => {}
    actual.device.assertNotVisible = async () => ({})
    actual.device.assertVisible = async args => {
      if (args.id === 'chat-message-history') {
        expect(stack.at(-1), 'Conversation must be restored').equals(
          'conversation'
        )
        calls.push('conversation')
      } else if (args.id != null) {
        expect(['chat-info-hero', 'chat-info-members']).includes(args.id)
        expect(['info', 'members']).includes(stack.at(-1))
        expect(safety, 'Safety must be closed with Done').equals(false)
      } else {
        expect(args.text).equals('Safety number.*')
        expect(safety).equals(true)
      }
      return {}
    }
    actual.device.tapOn = async args => {
      if (args.id === 'chat-conversation-identity') stack.push('info')
      else if (args.id === 'chat-info-member-' + memberId) safety = true
      else if (args.text === '^Mute$') muted = true
      else if (args.text === '^Done$') {
        calls.push('done')
        expect(safety).equals(true)
        if (fault === 'done-failed') throw Error('Observed Done failed')
        safety = false
      } else throw Error('Unexpected information control')
      render()
    }
    actual.device.back = async () => {
      calls.push('back')
      // Browser Back leaves the route; local safety state has no history entry.
      stack.pop()
      safety = false
      if (legacy && fault === 'missing-conversation') stack = []
      if (legacy && fault === 'lost-draft') draft = ''
      render()
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'cnv-group',
      viewerKey: 'Viewer',
      viewerId,
      f: {
        apiUrl: 'https://fixture.example.test/api/v1',
        actors: { Viewer: { userId: viewerId, provider: { sessionFile } } }
      },
      check: async (name: string, work: () => Promise<void>) => {
        if (name === 'E4 hero, fixed membership exclusions and same-user mute')
          await work()
      },
      openGroup: async () => {
        render()
      },
      anchor: async () => {},
      showInfoMember: async () => ({ userId: memberId })
    }) as Scenarios
    const fetchBefore = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.endsWith('/auth/me'))
        return Response.json({
          id: viewerId,
          displayName: 'Cal Ripken',
          isAdmin: false
        })
      if (url.endsWith('/preferences')) {
        muted = (JSON.parse(init?.body as string) as { muted: boolean }).muted
        return Response.json({ muted })
      }
      if (url.endsWith('/chat/conversations'))
        return Response.json([
          {
            id: 'cnv-group',
            kind: 'teamMembers',
            title: 'Synthetic members',
            scope: { type: 'team', id: 'tem-group' },
            scopeName: 'Synthetic',
            lastSeq: 1,
            lastMessageAt: null,
            unread: 0,
            canPost: true,
            canModerate: false,
            locked: false,
            noHolder: false,
            closed: false,
            memberCount: 2,
            preferences: { muted }
          }
        ])
      throw Error('Unexpected external request: ' + url)
    }
    let error: unknown
    try {
      await scenario.E4()
    } catch (failure) {
      error = failure
    } finally {
      globalThis.fetch = fetchBefore
    }
    return { calls, error }
  }
  it('returns from E4 local safety using Done and preserves the narrow conversation draft through the legacy members route', async () => {
    const result = await infoSafetyReturn()
    expect(result.error).equals(undefined)
    expect(result.calls).deep.equals([
      'done',
      'back',
      'conversation',
      'open-members',
      'back',
      'conversation'
    ])
  })
  for (const fault of ['done-failed', 'missing-conversation', 'lost-draft'])
    it('rejects an unproved E4 return: ' + fault, async () => {
      const result = await infoSafetyReturn(fault)
      expect(result.error).instanceOf(Error)
      if (fault === 'done-failed') {
        expect(String(result.error)).includes('Observed Done failed')
        expect(result.calls).deep.equals(['done'])
      } else if (fault === 'missing-conversation')
        expect(String(result.error)).includes('Conversation must be restored')
      else
        expect(String(result.error)).includes(
          'Keep this synthetic information draft'
        )
    })
  async function reactionPeerReadiness(fault = ''): Promise<{
    calls: string[]
    error: unknown
  }> {
    const { actual, page } = browserModel()
    Object.assign(actual, { surface: 'web-narrow' })
    const target = { id: 'msg-target', seq: 231 }
    const viewerId = userIdOfGumbo(7)
    const glyph = '👍️'
    const calls: string[] = []
    page.window.document.body.innerHTML =
      '<div data-testid="chat-bubble-msg-target"></div>' +
      '<div role="button" aria-label="thumbs up" style="opacity:1">' +
      glyph +
      '</div>'
    const button = page.window.document.querySelector('[role="button"]')!
    button.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      top: 10,
      left: 10,
      right: 50,
      bottom: 50,
      toJSON: () => ({})
    })
    page.window.document.elementFromPoint = () => button
    actual.device.dragAndDrop = async () => ({})
    actual.device.assertNotVisible = async () => ({})
    actual.device.inputText = async args => {
      expect(args.text).equals('thumbs up')
      return {}
    }
    actual.device.tapOn = async args => {
      if (args.css === '[role="button"][aria-label="thumbs up"]') {
        calls.push('tap-raw-glyph')
        return { element: { text: glyph } }
      }
      expect(args.css != null || args.text === '^More emoji$').equals(true)
      return {}
    }
    let loaded = fault !== 'missing-history'
    let reads = 0
    const post = (reaction: unknown): Record<string, unknown> => ({
      id: target.id,
      status: 'ok',
      reactions: reaction == null ? [] : [reaction]
    })
    const engine = {
      open: async (conversation: string) => {
        expect(conversation).equals('cnv-group')
        calls.push('open')
        reads++
        if (reads > 3) throw Error('No exact reaction observed in fixture')
        return {
          hasEarlier: !loaded,
          messages: loaded
            ? [
                post(
                  reads >= 3
                    ? {
                        emoji: fault === 'wrong-glyph' ? '👍' : glyph,
                        userIds: [
                          fault === 'wrong-viewer' ? userIdOfGumbo(8) : viewerId
                        ]
                      }
                    : null
                )
              ]
            : []
        }
      },
      loadEarlier: async (conversation: string) => {
        expect(conversation).equals('cnv-group')
        calls.push('load-earlier')
        loaded = true
        return { hasEarlier: false, messages: [post(null)] }
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'cnv-group',
      viewerId,
      observations: [],
      f: { messages: { target } },
      check: async (name: string, work: () => Promise<void>) => {
        if (
          name ===
          'E5 movement before hold cancels; reaction and personal pin remain usable'
        )
          await work()
      },
      anchor: async () => {},
      targetBounds: async () => ({ x: 10, y: 20, width: 200, height: 40 }),
      protocolPeer: async () => ({ engine })
    }) as Scenarios
    let error: unknown
    try {
      await scenario.E5()
    } catch (failure) {
      error = failure
    }
    return { calls, error }
  }
  for (const fault of ['', 'missing-history'])
    it(
      'waits for the exact E5 peer reaction after a verified raw-glyph tap: ' +
        (fault === '' ? 'delayed-delivery' : fault),
      async () => {
        const result = await reactionPeerReadiness(fault)
        expect(result.error).equals(undefined)
        expect(result.calls[0]).equals('tap-raw-glyph')
        expect(result.calls.filter(call => call === 'open')).length(3)
        expect(result.calls.includes('load-earlier')).equals(
          fault === 'missing-history'
        )
      }
    )
  for (const fault of ['wrong-glyph', 'wrong-viewer'])
    it(
      'rejects an E5 peer reaction without the exact raw glyph and viewer: ' +
        fault,
      async () => {
        const result = await reactionPeerReadiness(fault)
        expect(String(result.error)).includes(
          'No exact reaction observed in fixture'
        )
        expect(result.calls.filter(call => call === 'open')).length(4)
      }
    )
  async function browserReplacement(
    text: string,
    options: { fault?: string; previous?: string } = {}
  ): Promise<{ draft: string; calls: string[]; error: unknown }> {
    const { actual, page } = browserModel()
    const previous = options.previous ?? '@Juan S edited token 1234567405'
    Object.defineProperty(page.window.navigator, 'platform', {
      value: 'MacIntel'
    })
    const editor = page.window.document.createElement('textarea')
    editor.dataset.testid = 'chat-composer'
    editor.value = previous
    page.window.document.body.append(editor)
    const calls: string[] = []
    actual.device.tapOn = async args => {
      expect(args.id).equals('chat-composer')
      editor.focus()
      // A real center tap can put the caret before an unselected suffix.
      editor.setSelectionRange(previous.length - 3, previous.length - 3)
      calls.push('focus')
      return {}
    }
    const select = editor.select.bind(editor)
    editor.select = () => {
      calls.push('select-all')
      if (options.fault !== 'partial-selection') select()
    }
    actual.device.pressKey = async args => {
      expect(args.key).equals('Cmd+A')
      // A successful command response does not prove native text selection.
      calls.push('unapplied-shortcut')
      return {}
    }
    actual.device.eraseText = async (args = {}) => {
      calls.push('erase')
      if (options.fault === 'erase-leftover') return {}
      // The CDP backend sends 50 Backspaces by default, not Select All.
      for (let i = 0; i < Number(args.characters ?? 50); i++) {
        const start = editor.selectionStart
        const end = editor.selectionEnd
        editor.setRangeText(
          '',
          start === end ? Math.max(0, start - 1) : start,
          end,
          'end'
        )
        editor.dispatchEvent(
          new page.window.InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward'
          })
        )
      }
      return {}
    }
    actual.device.inputText = async args => {
      calls.push('input')
      const value =
        options.fault === 'lost-input'
          ? String(args.text).slice(0, -1)
          : String(args.text)
      editor.setRangeText(
        value,
        editor.selectionStart,
        editor.selectionEnd,
        'end'
      )
      editor.dispatchEvent(
        new page.window.InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value
        })
      )
      return {}
    }
    let error: unknown
    try {
      await actual.replaceDraft(text)
    } catch (failure) {
      error = failure
    }
    return { draft: editor.value, calls, error }
  }
  it('replaces a browser draft completely when the observed tap leaves a trailing numeric suffix', async () => {
    const result = await browserReplacement('A newer synthetic draft')
    expect(result.error).equals(undefined)
    expect(result.draft).equals('A newer synthetic draft')
    expect(result.calls).deep.equals(['focus', 'select-all', 'erase', 'input'])
  })
  it('selects and replaces an entire long multiline browser draft without a keyboard-shortcut assumption', async () => {
    const result = await browserReplacement('New first line\nNew second line', {
      previous: 'Old line\n' + 'Long synthetic draft '.repeat(8)
    })
    expect(result.error).equals(undefined)
    expect(result.draft).equals('New first line\nNew second line')
    expect(result.calls).deep.equals(['focus', 'select-all', 'erase', 'input'])
  })
  it('clears the entire browser draft for an exact empty replacement', async () => {
    const result = await browserReplacement('')
    expect(result.error).equals(undefined)
    expect(result.draft).equals('')
    expect(result.calls).deep.equals(['focus', 'select-all', 'erase'])
  })
  for (const fault of ['partial-selection', 'erase-leftover', 'lost-input'])
    it(
      'rejects an unproved complete browser replacement: ' + fault,
      async () => {
        const result = await browserReplacement('A newer synthetic draft', {
          fault
        })
        expect(String(result.error)).includes(
          fault === 'partial-selection'
            ? 'select the entire current draft'
            : fault === 'erase-leftover'
              ? 'completely clear the prior draft'
              : 'equal the complete expected draft'
        )
        if (fault !== 'lost-input') expect(result.calls).not.includes('input')
        if (fault === 'partial-selection')
          expect(result.calls).not.includes('erase')
      }
    )
  async function middleResizeReader(fault = ''): Promise<{
    error: unknown
    resizes: Array<{
      width: number
      draft: string
      reply: boolean
      file: boolean
    }>
    wheels: string[]
  }> {
    const target = { id: 'msg-resize-target', seq: 231 }
    let width = 390
    let y = 114
    let draft = ''
    let reply = false
    let file = false
    let absent = false
    const resizes: Array<{
      width: number
      draft: string
      reply: boolean
      file: boolean
    }> = []
    const wheels: string[] = []
    let zeroOffset = fault === 'zero-order' ? 42 : 0
    const ui = {
      native: false,
      deadline: AbortSignal.timeout(10000),
      metrics: () => ({ width, height: width === 390 ? 844 : 1000 }),
      append: async (text: string) => {
        draft += text
      },
      draft: async () => draft,
      back: async () => {},
      open: async () => {},
      id: async () => {},
      dom: async (script: string) => {
        if (script.includes('scrollTop=0')) zeroOffset = 0
        return { top: zeroOffset }
      },
      present: async (id: string) => {
        if (id === 'chat-attachment-chip') expect(file).equals(true)
        if (id === 'chat-bubble-' + target.id && absent)
          throw Error('Exact public resize row is absent')
      },
      resize: async (next: number) => {
        resizes.push({ width: next, draft, reply, file })
        // Existing contract: only a newly covering top band reveals the edge.
        if (next === 1440 && y >= 106 && y < 162) y = 170
        width = next
      },
      device: {
        assertVisible: async (args: { text: string }) => {
          expect(args.text).equals('^Cancel reply$')
          expect(reply).equals(true)
        },
        scroll: async (args: { direction: string }) => {
          wheels.push(args.direction)
          expect(args.direction).equals('UP')
          if (fault === 'absent') absent = true
          if (fault !== 'covered') y += 300
          return { ordinaryWheel: true }
        }
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      group: 'cnv-resize',
      observations: [],
      f: { messages: { target, oldest: { id: 'msg-oldest', seq: 1 } } },
      check: async (name: string, work: () => Promise<void>) => {
        if (
          name ===
          'E9 middle/top-zero/end reader with multiline reply/file retained'
        )
          await work()
      },
      openGroup: async () => {},
      anchor: async () => {
        y = 114
      },
      reply: async () => {
        reply = true
      },
      attachPhoto: async () => {
        file = true
      },
      openInfo: async () => {},
      ownWebReader: async (_target: unknown, zero = false) => {
        if (zero) expect(zeroOffset, 'Physical oldest zero required').equals(0)
        else if (fault === 'already-middle') y = 360
      },
      webAnchorReady: async () => {},
      readingBand: async () => ({
        top: width === 390 ? 106 : 162,
        bottom: width === 390 ? 606 : 847
      }),
      targetBounds: async (id: string) => {
        expect(id).equals('chat-bubble-' + target.id)
        if (absent) throw Error('Exact public resize row is absent')
        return { x: 48, y, width: 215, height: 108 }
      },
      cancelReply: async () => {
        reply = false
      }
    }) as Scenarios
    let error: unknown
    try {
      await scenario.E9()
    } catch (failure) {
      error = failure
    }
    return { error, resizes, wheels }
  }
  it('keeps E9 strict round-trip geometry for an exact middle reader without invoking newly-covered-edge avoidance', async () => {
    const result = await middleResizeReader()
    expect(result.error).equals(undefined)
    expect(result.wheels).deep.equals(['UP'])
    expect(result.resizes).deep.equals(
      [1440, 390].map(width => ({
        width,
        draft: 'Keep a multiline\nreader draft',
        reply: true,
        file: true
      }))
    )
  })
  it('sets the explicit E9 oldest zero before guarded real scroll ownership after an offset42 anchor', async () => {
    const result = await middleResizeReader('zero-order')
    expect(result.error).equals(undefined)
    expect(result.resizes).length(2)
  })
  it('keeps an already middle E9 exact reader without a redundant additional UP wheel', async () => {
    const result = await middleResizeReader('already-middle')
    expect(result.error).equals(undefined)
    expect(result.wheels).deep.equals([])
    expect(result.resizes).length(2)
  })
  for (const fault of ['covered', 'absent'])
    it('refuses an unproved E9 middle-reader baseline: ' + fault, async () => {
      const result = await middleResizeReader(fault)
      expect(String(result.error)).includes(
        fault === 'absent'
          ? 'Exact public resize row is absent'
          : 'Exact resize reader must be clearly inside the readable band'
      )
      expect(result.resizes).deep.equals([])
    })
  async function accountSwitchTyping(fault = ''): Promise<{
    calls: string[]
    draft: string
    error: unknown
    observations: Array<Record<string, unknown>>
  }> {
    const { actual, page } = browserModel()
    const directory = mkdtempSync(join(tmpdir(), 'chat-account-draft-'))
    directories.push(directory)
    const image = join(directory, 'synthetic.png')
    writeFileSync(image, captureImages[0], { mode: 0o600 })
    const kinds = [
      'chat-list',
      'conversation',
      'floating-pins',
      'message-actions',
      'reply-keyboard',
      'info',
      'info-members',
      'mentions',
      'mention-composer',
      'attention'
    ]
    const files = ['web-wide', 'web-narrow', 'web-touch', 'ios', 'android']
      .flatMap(surface =>
        kinds.map(kind => surface + '-' + kind + '-after.png')
      )
      .concat([
        'ios-keyboard-pins-after.png',
        'android-keyboard-pins-after.png',
        'web-320-composer-after.png'
      ])
    const archive = join(directory, 'unit-archive.json')
    const source = '0'.repeat(40)
    writeFileSync(
      archive,
      JSON.stringify({
        entries: files.map(file => ({
          file,
          path: image,
          source,
          sha256: createHash('sha256').update(captureImages[0]).digest('hex')
        }))
      }),
      { mode: 0o600 }
    )
    const sessionFile = join(directory, 'session.json')
    writeFileSync(sessionFile, JSON.stringify({ token: 'TEST_TOKEN' }), {
      mode: 0o600
    })
    const switchedId = userIdOfGumbo(8)
    const calls: string[] = []
    const editor = page.window.document.createElement('textarea')
    editor.dataset.testid = 'chat-composer'
    page.window.document.body.append(editor)
    actual.replaceDraft = async value => {
      editor.value = value
      editor.focus()
    }
    actual.absent = async () => {}
    actual.device.assertNotVisible = async () => ({})
    actual.device.tapOn = async args => {
      if (args.id === 'chat-composer') {
        calls.push('focus')
        if (fault === 'focus-failed')
          throw Error('Observed composer tap failed')
        editor.focus()
      } else if (args.text === '^Send$') {
        calls.push('send')
        if (editor.value === '')
          throw Error('Send is disabled: actual composer is empty')
      } else throw Error('Unexpected public control')
    }
    actual.device.inputText = async args => {
      calls.push('input')
      // Selector-free browser input targets the currently focused element.
      if (
        page.window.document.activeElement === editor &&
        fault !== 'lost-input'
      )
        editor.value += String(args.text)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerKey: 'Original',
      observations: [],
      f: {
        apiUrl: 'https://fixture.example.test/api/v1',
        afterArchive: archive,
        switchActor: 'Switch',
        actors: { Switch: { userId: switchedId, provider: { sessionFile } } },
        conversations: {
          attentionStress: { id: 'cnv-old' },
          switch: { id: 'cnv-new' }
        },
        historyStress: {
          viewer: 'Original',
          neutralTail: { body: 'Previous account reader' }
        }
      },
      check: async (name: string, work: () => Promise<void>) => {
        if (
          name ===
          'E11 real public account switch clears old reader, draft and attention'
        )
          await work()
      },
      signIn: async () => {},
      openGroup: async (id: string) => {
        editor.blur()
        editor.value =
          id === 'cnv-new' && fault === 'retained-draft'
            ? 'Previous account draft'
            : ''
      },
      delivered: async (body: string, id: string) => {
        expect(id).equals('cnv-new')
        expect(body).equals(editor.value)
        calls.push('delivered')
        return { body }
      }
    }) as Scenarios
    const fetchBefore = globalThis.fetch
    const sourceBefore = process.env.CHAT2_SOURCE
    globalThis.fetch = async input => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.endsWith('/auth/me'))
        return Response.json({
          id: switchedId,
          displayName: 'Cal Ripken',
          isAdmin: false
        })
      if (url.endsWith('/chat/conversations')) return Response.json([])
      throw Error('Unexpected external request: ' + url)
    }
    process.env.CHAT2_SOURCE = source
    let error: unknown
    try {
      await scenario.E11()
    } catch (failure) {
      error = failure
    } finally {
      globalThis.fetch = fetchBefore
      if (sourceBefore == null) delete process.env.CHAT2_SOURCE
      else process.env.CHAT2_SOURCE = sourceBefore
    }
    return {
      calls,
      draft: editor.value,
      error,
      observations: scenario.observations
    }
  }
  it('focuses the new-account composer after E11 navigation and sends exactly the freshly typed note', async () => {
    const result = await accountSwitchTyping()
    expect(result.error).equals(undefined)
    expect(result.calls).deep.equals(['focus', 'input', 'send', 'delivered'])
    expect(result.draft).matches(
      /^A fresh account-specific synthetic note \d+$/
    )
    expect(result.observations.at(-1)?.actualNormalAccountSwitch).equals(true)
  })
  for (const fault of ['lost-input', 'retained-draft', 'focus-failed'])
    it('does not send an unproved account-switch draft: ' + fault, async () => {
      const result = await accountSwitchTyping(fault)
      expect(String(result.error)).includes(
        fault === 'lost-input'
          ? 'New-account composer must contain exactly'
          : fault === 'focus-failed'
            ? 'Observed composer tap failed'
            : 'Previous account draft'
      )
      expect(result.calls).not.includes('send')
      expect(result.calls).not.includes('delivered')
    })
  it('runs the authorization-changing scenario last without losing or duplicating any scenario', () => {
    expect(CHAT2_SCENARIOS.at(-1)).equals('E8')
    expect(new Set(CHAT2_SCENARIOS).size).equals(CHAT2_SCENARIOS.length)
    expect([...CHAT2_SCENARIOS].sort()).deep.equals(
      [
        'E1',
        'E2',
        'E3',
        'E4',
        'E5',
        'E6',
        'E7',
        'E8',
        'E9',
        'E10',
        'E11'
      ].sort()
    )
  })
  async function resizedViewport(fault = ''): Promise<{
    actual: Chat2UI
    reads: number
    calls: unknown[]
    error: unknown
  }> {
    const actual = ui([], 'web-wide')
    const page = new JSDOM('<!doctype html><body></body>', {
      url: 'https://fixture.example.test/chat',
      runScripts: 'outside-only'
    })
    browserDocuments.push(page)
    Object.assign(actual, { deadline: AbortSignal.timeout(10000) })
    actual.device.evalBrowserScript = async args => ({
      data: await page.window.eval('(async()=>{' + String(args.script) + '})()')
    })
    delete (actual as Partial<Chat2UI>).metrics
    const before = { width: 1440, height: 1000, dpr: 2, coarse: true }
    Object.assign(actual, { webFrame: before })
    const calls: unknown[] = []
    let reads = 0
    let frame = {
      width: 561,
      height: 1215,
      dpr: 2,
      coarse: true,
      scale: 0.6951871514320374
    }
    Object.defineProperties(page.window, {
      innerWidth: { get: () => frame.width, configurable: true },
      innerHeight: { get: () => frame.height, configurable: true },
      devicePixelRatio: { get: () => frame.dpr },
      visualViewport: { get: () => ({ scale: frame.scale }) },
      matchMedia: { value: () => ({ matches: frame.coarse }) }
    })
    Object.assign(actual, {
      cdp: {
        send: async (method: string, args: unknown) => {
          calls.push([method, args])
        }
      }
    })
    const evaluate = actual.device.evalBrowserScript
    const now = Date.now
    let elapsed = 0
    Date.now = () => now() + elapsed
    actual.device.evalBrowserScript = async (args, options) => {
      reads += 1
      expect(options?.signal).instanceOf(AbortSignal)
      expect(options?.signal.aborted).equals(false)
      if (fault === 'transport') throw Error('Observed resize transport failed')
      if (fault !== '' || reads > 1) {
        frame = { width: 390, height: 844, dpr: 2, coarse: true, scale: 1 }
        if (fault === 'dimensions') frame.width = 561
        if (fault === 'scale') frame.scale = 0.6951871514320374
        if (fault === 'dpr') frame.dpr = 1
        if (fault === 'pointer') frame.coarse = false
      }
      if (fault !== '') elapsed += 1001
      return await evaluate(args, options)
    }
    let error: unknown
    try {
      await actual.resize(390, 844)
    } catch (failure) {
      error = failure
    } finally {
      Date.now = now
    }
    expect(calls).deep.equals([
      [
        'Emulation.setDeviceMetricsOverride',
        { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      ]
    ])
    if (error != null) expect(actual.metrics()).deep.equals(before)
    return { actual, reads, calls, error }
  }
  it('waits for the exact touch viewport after the observed transient 561px return layout', async () => {
    const result = await resizedViewport()
    expect(result.error).equals(undefined)
    expect(result.reads).equals(2)
    expect(result.actual.metrics()).deep.equals({
      width: 390,
      height: 844,
      dpr: 2,
      coarse: true
    })
    expect(result.actual.steps.at(-1)?.outcome).equals('passed')
  })
  for (const fault of ['dimensions', 'scale', 'dpr', 'pointer', 'transport'])
    it(
      'rejects a persistent or unobserved resized browser frame: ' + fault,
      async () => {
        const result = await resizedViewport(fault)
        expect(String(result.error)).includes(
          fault === 'transport'
            ? 'Observed resize transport failed'
            : 'Actual resized viewport/pointer/pixel scale differs'
        )
        expect(result.reads).at.most(3)
        if (fault !== 'transport')
          expect(result.actual.steps.at(-1)?.outcome).equals('failed')
      }
    )
  it('reports the actual resized browser frame instead of the surface default', () => {
    const actual = ui([], 'web-wide')
    delete (actual as Partial<Chat2UI>).metrics
    Object.assign(actual, {
      webFrame: { width: 1440, height: 600, dpr: 1, coarse: false }
    })
    expect(actual.metrics()).deep.equals({
      width: 1440,
      height: 600,
      dpr: 1,
      coarse: false
    })
  })
  function replyCancellation(mode = 'valid'): {
    scenario: Scenarios
    actual: Chat2UI
    calls: unknown[]
  } {
    const actual = ui([])
    const calls: unknown[] = []
    let tapped = false
    let photographed = false
    const tree = (): Array<Record<string, unknown>> => {
      const cleared =
        tapped &&
        mode !== 'no-progress' &&
        !(photographed && mode === 'resurrected')
      const band = {
        x: 16,
        y: cleared ? 480 : 400,
        width: 268,
        height: cleared ? 70 : 150
      }
      const editor = { x: 65, y: 500, width: 160, height: 44 }
      if (tapped && mode === 'moved-editor') editor.y += 10
      if (cleared && mode === 'wrong-band') band.width -= 10
      const result = [
        node(0, 'Other', { identifier: 'chat-composer-band', rect: band }),
        node(1, 'TextView', {
          identifier: 'chat-composer',
          label: 'Message',
          value:
            tapped && mode === 'changed-text'
              ? 'Changed'
              : 'Draft with attachment',
          rect: editor
        }),
        node(2, 'Other', {
          identifier: 'chat-attachment-chip',
          rect: { x: 20, y: 450, width: 200, height: 24 }
        })
      ]
      if (!cleared)
        result.push(
          node(3, 'Button', {
            label: 'Cancel reply',
            enabled:
              mode === 'disabled'
                ? false
                : mode === 'unknown'
                  ? undefined
                  : true,
            rect: {
              x: 250,
              y: mode === 'outside' ? 350 : 410,
              width: 24,
              height: 24
            }
          })
        )
      if (mode === 'ambiguous') result.push({ ...result[3], index: 4 })
      return result
    }
    actual.device = {
      hierarchyRaw: async () => {
        calls.push('raw')
        return raw(
          mode === 'capped'
            ? Array.from({ length: 300 }, (_, index) =>
                node(index, 'StaticText', { label: 'Ordinary history' })
              )
            : tree()
        )
      },
      assertVisible: async (selected: Record<string, unknown>) => {
        calls.push(selected)
        if (mode === 'missing' || mode === 'transport') throw Error(mode)
        const item = tree().find(n =>
          selected.id != null
            ? n.identifier === selected.id
            : n.label === selected.text
        )
        if (item == null) throw Error('No actual element')
        return {
          element: {
            id: item.identifier,
            class: item.type,
            accessibilityLabel: item.label,
            text: item.value ?? item.label,
            enabled: item.enabled,
            bounds: item.rect
          }
        }
      },
      tapOnPoint: async (point: unknown) => {
        calls.push(point)
        tapped = true
      },
      screenshot: async () => {
        photographed = true
        calls.push('image')
        return captureImages[0]
      }
    } as unknown as Chat2UI['device']
    actual.visible = async () => {
      throw Error('Optional visibility cannot certify required cancellation')
    }
    actual.text = async () => {
      throw Error('Use the actual measured control')
    }
    return {
      actual,
      calls,
      scenario: Object.assign(Object.create(Scenarios.prototype), {
        ui: actual,
        observations: []
      }) as Scenarios
    }
  }
  for (const mode of ['valid', 'capped'])
    it(
      'requires observed native reply cancellation and preserves editor through ' +
        mode +
        ' metadata',
      async () => {
        const model = replyCancellation(mode)
        await model.scenario.cancelReply(1000)
        expect(model.calls).includes('image')
        expect(model.calls).deep.includes({ x: 262, y: 422 })
        if (mode === 'capped')
          expect(model.calls).deep.includes({
            text: 'Cancel reply',
            timeout: 120
          })
        const proof = model.scenario.observations[0] as Record<string, unknown>
        expect(proof.outcome).equals('passed')
        expect(
          (proof.before as { editor: { text: string } }).editor.text
        ).equals('Draft with attachment')
        expect(
          (proof.verified as { editor: { text: string } }).editor.text
        ).equals('Draft with attachment')
        expect((proof.image as { rawPath: string }).rawPath).a('string')
      }
    )
  for (const mode of [
    'disabled',
    'unknown',
    'ambiguous',
    'outside',
    'missing',
    'transport',
    'no-progress',
    'moved-editor',
    'changed-text',
    'wrong-band',
    'resurrected'
  ])
    it(
      'fails required native cancellation instead of silently navigating after ' +
        mode,
      async () => {
        const model = replyCancellation(mode)
        if (mode === 'missing' || mode === 'transport')
          Object.assign(model.actual.device, {
            hierarchyRaw: async () => raw([])
          })
        await captureFailure(model.scenario.cancelReply(60))
        expect(
          (model.scenario.observations[0] as { outcome: string }).outcome
        ).equals('failed')
        if (
          [
            'disabled',
            'unknown',
            'ambiguous',
            'outside',
            'missing',
            'transport'
          ].includes(mode)
        )
          expect(model.calls).not.deep.includes({ x: 262, y: 422 })
      }
    )
  it('requires positive cancellation and absence on web and Android without optional skips', async () => {
    for (const surface of ['web-wide', 'android']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.device.assertVisible = async args => {
        calls.push(['present', args])
      }
      actual.device.assertNotVisible = async args => {
        calls.push(['absent', args])
      }
      actual.text = async label => {
        calls.push(['tap', label])
      }
      const scenario = Object.assign(Object.create(Scenarios.prototype), {
        ui: actual
      }) as Scenarios
      await scenario.cancelReply()
      expect(calls).deep.equals([
        ['present', { text: '^Cancel reply$' }],
        ['tap', 'Cancel reply'],
        ['absent', { text: '^Cancel reply$' }]
      ])
    }
  })
  function picker(scale = 1): Array<Record<string, unknown>> {
    const rect = (
      x: number,
      y: number,
      width: number,
      height: number
    ): CaptureBox => ({
      x: x * scale,
      y: y * scale,
      width: width * scale,
      height: height * scale
    })
    return [
      node(0, 'Other', { rect: rect(0, 0, 300, 600) }),
      node(1, 'Other', {
        identifier: 'chat-picker-scene',
        parentIndex: 0,
        rect: rect(0, 0, 300, 600)
      }),
      node(2, 'Other', {
        identifier: 'chat-picker-transition',
        parentIndex: 1,
        rect: rect(0, 0, 300, 600)
      }),
      node(3, 'Other', {
        identifier: 'chat-picker-header',
        parentIndex: 2,
        rect: rect(0, 0, 300, 60)
      }),
      node(4, 'Other', { parentIndex: 2, rect: rect(0, 0, 300, 60) }),
      node(5, 'Button', {
        label: 'Cancel',
        parentIndex: 4,
        rect: rect(210, 6, 80, 47.999)
      }),
      node(6, 'StaticText', {
        label: 'Mention a member',
        parentIndex: 4,
        rect: rect(10, 20, 140, 23)
      }),
      node(7, 'Other', {
        identifier: 'chat-picker-content',
        parentIndex: 2,
        rect: rect(0, 0, 300, 600)
      }),
      node(8, 'TextField', {
        label: 'Search members',
        parentIndex: 7,
        rect: rect(10, 80, 280, 44)
      }),
      node(9, 'Other', {
        label: 'Mention a member',
        parentIndex: 4,
        rect: rect(0, 0, 300, 60)
      })
    ]
  }
  function setPickerRaw(
    actual: Chat2UI,
    read: () => Promise<Uint8Array>
  ): void {
    Object.assign(actual.device, { hierarchyRaw: read })
  }
  for (const scale of [1, 2, 3])
    it(
      'reads one actual picker tree with a same-bounds header sibling in its original coordinate units: ' +
        scale,
      () => {
        const result = iosMentionHeaderGeometry(raw(picker(scale)))
        expect(result.scope).equals(
          'same-bounds native header sibling under picker transition'
        )
        expect(result.geometry.cancel).deep.equals({
          x: 210 * scale,
          y: 6 * scale,
          width: 80 * scale,
          height: 47.999 * scale
        })
        expect(result.geometry.header).deep.equals({
          x: 0,
          y: 0,
          width: 300 * scale,
          height: 60 * scale
        })
      }
    )
  it('also accepts actual title and Cancel descendants of the header marker', () => {
    const tree = picker()
    tree[5].parentIndex = tree[6].parentIndex = 3
    expect(iosMentionHeaderGeometry(raw(tree)).scope).equals(
      'header descendants'
    )
  })
  const invalidPickers: Array<
    [string, (tree: Array<Record<string, unknown>>) => void]
  > = [
    ...[1, 2, 3, 5, 6, 7, 8].map(
      index =>
        [
          'duplicate identity or typed control ' + index,
          (tree: Array<Record<string, unknown>>) => {
            tree.push({ ...tree[index], index: 20 })
          }
        ] as [string, (tree: Array<Record<string, unknown>>) => void]
    ),
    [
      'outside scene transition',
      tree => {
        tree[2].parentIndex = 0
      }
    ],
    [
      'outside transition header',
      tree => {
        tree[3].parentIndex = 0
      }
    ],
    [
      'outside content Search',
      tree => {
        tree[8].parentIndex = 0
      }
    ],
    [
      'different same-scene carrier',
      tree => {
        tree.push({ ...tree[4], index: 20 })
        tree[5].parentIndex = 20
      }
    ],
    [
      'carrier geometry differs',
      tree => {
        tree[4].rect = { x: 0, y: 0, width: 280, height: 60 }
      }
    ],
    [
      'title and Cancel overlap',
      tree => {
        tree[5].rect = { x: 100, y: 6, width: 80, height: 48 }
      }
    ],
    [
      'Cancel outside header',
      tree => {
        tree[5].rect = { x: 250, y: 6, width: 80, height: 48 }
      }
    ],
    [
      'small Cancel target',
      tree => {
        tree[5].rect = { x: 210, y: 6, width: 46, height: 46 }
      }
    ],
    [
      'Search above header',
      tree => {
        tree[8].rect = { x: 10, y: 10, width: 280, height: 44 }
      }
    ],
    [
      'disabled Cancel',
      tree => {
        tree[5].enabled = false
      }
    ],
    [
      'unknown Search state',
      tree => {
        delete tree[8].enabled
      }
    ],
    [
      'cyclic transition',
      tree => {
        tree[2].parentIndex = 2
      }
    ],
    [
      'missing ancestor',
      tree => {
        tree[5].parentIndex = 999
      }
    ],
    [
      'missing Search',
      tree => {
        tree.splice(8, 1)
      }
    ],
    [
      'nonfinite title geometry',
      tree => {
        tree[6].rect = { x: Infinity, y: 20, width: 140, height: 23 }
      }
    ],
    [
      'zero header geometry',
      tree => {
        tree[3].rect = { x: 0, y: 0, width: 0, height: 60 }
      }
    ],
    [
      'whole-scene title label',
      tree => {
        tree[6].rect = { x: 0, y: 0, width: 300, height: 600 }
      }
    ],
    [
      'footer header',
      tree => {
        for (const index of [3, 4, 5, 6]) {
          const box = tree[index].rect as CaptureBox
          tree[index].rect = { ...box, y: box.y + 400 }
        }
      }
    ]
  ]
  for (const [name, change] of invalidPickers)
    it('rejects unproved atomic native picker geometry: ' + name, () => {
      const tree = picker()
      change(tree)
      expect(() => iosMentionHeaderGeometry(raw(tree))).throws()
    })
  it('takes fresh atomic picker snapshots until two positive geometries remain stable, retaining the real bytes', async () => {
    const actual = ui([])
    let reads = 0
    const snapshots: Buffer[] = []
    setPickerRaw(actual, async () => {
      const tree = picker()
      if (++reads === 1)
        for (const index of [3, 4, 5, 6, 8]) {
          const box = tree[index].rect as CaptureBox
          tree[index].rect = { ...box, y: box.y + 5 }
        }
      const bytes = raw(tree)
      snapshots.push(bytes)
      return bytes
    })
    actual.present = async () => {
      throw Error('No separate native metadata probes')
    }
    actual.observedBounds = async () => {
      throw Error('No unscoped geometry fallback')
    }
    await observeMentionHeader(actual, 1500)
    const step = actual.steps.find(
      step => step.name === 'Settled mention chooser header geometry'
    )!
    expect(step.outcome).equals('passed')
    const samples = step.samples as Array<{
      rawHierarchy: { path: string }
      bounds: ReturnType<typeof iosMentionHeaderGeometry>['geometry']
    }>
    expect(samples.length).at.least(3)
    for (let i = 0; i < samples.length; i++)
      expect(
        readFileSync(samples[i].rawHierarchy.path).equals(snapshots[i])
      ).equals(true)
    expect(samples.at(-1)!.bounds.header.y).equals(0)
  })
  it('times out continuous picker motion instead of accepting its latest sample', async () => {
    const actual = ui([])
    let reads = 0
    setPickerRaw(actual, async () => {
      const tree = picker()
      const offset = ++reads * 0.2
      for (const index of [3, 4, 5, 6, 8]) {
        const box = tree[index].rect as CaptureBox
        tree[index].rect = { ...box, y: box.y + offset }
      }
      return raw(tree)
    })
    expect(
      String(await captureFailure(observeMentionHeader(actual, 300)))
    ).contains('Timed out')
  })
  it('propagates native transport failures without a snapshot or fallback success', async () => {
    const actual = ui([])
    const error = Error('Transport unavailable')
    setPickerRaw(actual, async () => {
      throw error
    })
    expect(await captureFailure(observeMentionHeader(actual, 500))).equals(
      error
    )
    expect(actual.steps[0].outcome).equals('failed')
  })
  it('rejects the loss of a positive Cancel control in a later fresh snapshot', async () => {
    const actual = ui([])
    let reads = 0
    setPickerRaw(actual, async () => {
      const tree = picker()
      if (++reads > 1) tree[5].enabled = false
      return raw(tree)
    })
    await captureFailure(observeMentionHeader(actual, 500))
    expect(actual.steps[0].outcome).equals('failed')
  })
  it('keeps the existing web scoped measurement path', async () => {
    const actual = ui([], 'web-wide')
    const selectors: unknown[] = []
    actual.present = async id => {
      selectors.push(id)
    }
    const geometry = iosMentionHeaderGeometry(raw(picker())).geometry
    actual.observedBounds = async args => {
      selectors.push(args)
      if (args.id === 'chat-picker-header') return geometry.header
      if (args.text === '^Mention a member$') return geometry.title
      if (args.text === '^Cancel$') return geometry.cancel
      return geometry.search
    }
    setPickerRaw(actual, async () => {
      throw Error('No iOS snapshot path')
    })
    await observeMentionHeader(actual, 1500)
    expect(selectors.slice(0, 2)).deep.equals([
      'chat-picker-scene',
      'chat-picker-header'
    ])
    expect(selectors).deep.includes({
      text: '^Cancel$',
      childOf: { id: 'chat-picker-header' }
    })
  })
  function editable(
    mode = 'capped',
    initial = 'B',
    attached = false,
    complete = false
  ): {
    actual: Chat2UI
    calls: string[]
    value: () => string
    context: { reply: boolean; attached: boolean }
  } {
    const actual = ui([])
    const calls: string[] = []
    const context = { reply: true, attached }
    let value = initial
    let menu = false
    let selected = false
    let sentinelTyped = false
    let choosing = false
    const emptyName = (): string =>
      mode === 'dynamic-empty-name' || mode === 'raw-empty-name' || complete
        ? 'Message Message'
        : mode === 'unrelated-empty-name'
          ? 'Another field'
          : mode === 'triple-empty-name'
            ? 'Message Message Message'
            : 'Message'
    const field = (): Record<string, unknown> => ({
      id: mode === 'wrong-id' ? 'other' : 'chat-composer',
      class: 'TextView',
      text: value.trim() !== '' ? value.trim() : emptyName(),
      accessibilityLabel: value === '' ? emptyName() : 'Message',
      enabled: mode !== 'disabled-editor',
      bounds: {
        ...box,
        y: mode === 'moved-editor' && value === '' ? 40 : box.y
      }
    })
    ;(
      actual.device as typeof actual.device & {
        hierarchyRaw: () => Promise<Uint8Array>
      }
    ).hierarchyRaw = async () => {
      calls.push('raw')
      if (choosing)
        return raw([
          node(0, 'Other', { identifier: 'chat-picker-scene' }),
          node(1, 'Other', { identifier: 'chat-picker-header' }),
          ...(mode === 'mention-missing-search'
            ? []
            : [
                node(2, 'TextField', {
                  label: 'Search members',
                  enabled: mode !== 'mention-disabled-search'
                })
              ]),
          ...(mode === 'mention-ambiguous-search'
            ? [node(3, 'TextField', { label: 'Search members' })]
            : [])
        ])
      const nodes = [
        node(0, 'Keyboard', {
          rect: { x: 0, y: 400, width: 300, height: 200 }
        }),
        ...(mode === 'missing-delete'
          ? []
          : [
              node(1, 'Key', {
                label: 'delete',
                enabled: mode !== 'disabled-delete',
                rect: { x: 250, y: 450, width: 40, height: 40 }
              })
            ])
      ]
      if (mode === 'ambiguous-delete')
        nodes.push(
          node(5, 'Key', {
            label: 'delete',
            rect: { x: 200, y: 450, width: 40, height: 40 }
          })
        )
      if (
        complete ||
        mode === 'raw' ||
        mode === 'raw-empty-name' ||
        (mode === 'literal-placeholder-after' &&
          sentinelTyped &&
          value === 'Message')
      )
        nodes.push(
          node(2, 'TextView', {
            identifier: 'chat-composer',
            label:
              value === '' ||
              (mode === 'retained-aggregated-placeholder' &&
                value === 'Message Message')
                ? emptyName()
                : 'Message',
            ...(complete ? {} : { placeholderValue: 'Message' }),
            rect: field().bounds,
            value: value.trim() !== '' ? value.trim() : undefined
          })
        )
      if (
        menu &&
        !['no-select-all', 'missing-menu'].includes(mode) &&
        !(mode === 'dynamic-empty-name' && value === '')
      ) {
        nodes.push(
          node(3, 'MenuItem', {
            label: 'Select All',
            enabled: mode !== 'disabled-menu',
            rect: { x: 10, y: 200, width: 80, height: 30 }
          })
        )
        if (mode === 'ambiguous-menu')
          nodes.push(
            node(4, 'MenuItem', {
              label: 'Select All',
              rect: { x: 100, y: 200, width: 80, height: 30 }
            })
          )
      }
      if (mode !== 'raw')
        for (let i = nodes.length; nodes.length < 300; i++)
          nodes.push(node(10 + i, 'Other'))
      return raw(nodes)
    }
    actual.device.assertVisible = async args => {
      calls.push('read:' + String(args.id ?? args.text))
      if (args.id === 'chat-composer' && !choosing) return { element: field() }
      if (
        choosing &&
        ['chat-picker-scene', 'chat-picker-header'].includes(String(args.id))
      ) {
        if (
          mode === 'mention-missing-header' &&
          args.id === 'chat-picker-header'
        )
          throw new Error('Actual picker header missing')
        return { element: { id: args.id, bounds: box } }
      }
      if (args.text === 'Send')
        return {
          element: {
            class: 'Button',
            text: 'Send',
            accessibilityLabel: 'Send',
            bounds: box,
            enabled:
              mode === 'unknown-send'
                ? undefined
                : value.trim() !== '' || attached || mode === 'enabled-send'
          }
        }
      if (args.id === 'chat-attachment-chip' && attached)
        return {
          element: {
            id: 'chat-attachment-chip',
            class: 'Other',
            enabled: true,
            bounds: box
          }
        }
      throw new Error('Positive actual control missing')
    }
    actual.device.tapOn = async args => {
      if (choosing && args.text === '^Cancel$') {
        calls.push('cancel')
        choosing = false
        return
      }
      if (choosing && args.id === 'chat-mention-member-2') {
        calls.push('choose')
        value = '@Aaron Judge '
        choosing = false
        return
      }
      expect(args).deep.equals({ id: 'chat-composer' })
      calls.push('focus')
    }
    actual.device.longPressOn = async args => {
      expect(args).deep.equals({ id: 'chat-composer', duration: 600 })
      calls.push('hold')
      menu = true
      selected = mode === 'no-select-all' && !value.includes(' ')
    }
    actual.device.tapOnPoint = async args => {
      calls.push('point:' + String(args.point))
      if (args.point === '50,215') {
        selected = mode !== 'partial-delete'
        menu = false
      } else if (args.point === '270,470') {
        if (sentinelTyped && mode === 'retained-sentinel-name') value = '777'
        else if (sentinelTyped && mode === 'literal-placeholder-after')
          value = 'Message'
        else if (sentinelTyped && mode === 'retained-aggregated-placeholder')
          value = 'Message Message'
        else if (!['retained-text', 'retained-placeholder'].includes(mode))
          value = selected ? '' : value.slice(0, -1)
        selected = false
        menu = false
      } else throw new Error('Unobserved editor point')
    }
    actual.device.inputText = async args => {
      if (mode.startsWith('mention-') && args.text === '@')
        expect([undefined, 'chat-composer']).includes(args.id)
      else expect(args.id).equals('chat-composer')
      calls.push('type:' + String(args.text))
      value += String(args.text)
      if (mode.startsWith('mention-') && value === '@') choosing = true
      if (args.text === '7777') {
        sentinelTyped = true
        if (mode === 'stale-sentinel') value = '777'
      }
    }
    actual.device.screenshot = async () => captureImages[0]
    actual.device.eraseText = async () => {
      calls.push('erase-ACK')
      return {}
    }
    actual.device.copyTextFrom = async () => {
      throw new Error('No clipboard mutation')
    }
    return { actual, calls, value: () => value, context }
  }
  it('clears a capped iOS editor through observed UI and a positively read disjoint sentinel', async () => {
    const model = editable()
    await model.actual.replaceDraft('')
    expect(model.value()).equals('')
    expect(model.context).deep.equals({ reply: true, attached: false })
    expect(model.calls).includes('type:7777')
    expect(model.calls).not.includes('erase-ACK')
    expect(model.calls.filter(call => call === 'point:270,470')).length(2)
    const proof = model.actual.steps.find(
      step => step.name === 'Observed iOS editor replacement'
    )!
    expect(proof.outcome).equals('passed')
    expect(proof.emptyEvidence).contains('lossy AX')
  })
  it('accepts the exact label-plus-placeholder empty name after a fresh singly labelled sentinel', async () => {
    const model = editable('dynamic-empty-name', '')
    await model.actual.replaceDraft('')
    const proof = model.actual.steps.find(
      step => step.name === 'Observed iOS editor replacement'
    )!
    expect(proof.before).deep.includes({
      label: 'Message Message',
      text: 'Message Message'
    })
    expect(proof.sentinel).deep.includes({ label: 'Message', text: '7777' })
    expect(proof.after).deep.includes({
      label: 'Message Message',
      text: 'Message Message'
    })
    expect(model.value()).equals('')
    expect(proof.outcome).equals('passed')
  })
  it('proves a complete raw empty editor with omitted value and placeholder only after the exact disjoint sentinel is deleted', async () => {
    const model = editable('dynamic-empty-name', '', false, true)
    await model.actual.replaceDraft('')
    const proof = model.actual.steps.find(
      step => step.name === 'Observed iOS editor replacement'
    )!
    expect(proof.before).deep.includes({
      index: 2,
      label: 'Message Message',
      value: undefined,
      placeholderValue: undefined
    })
    expect(proof.sentinel).deep.includes({
      index: 2,
      label: 'Message',
      value: '7777',
      text: '7777'
    })
    expect(proof.after).deep.includes({
      index: 2,
      label: 'Message Message',
      value: undefined,
      text: 'Message Message'
    })
    expect(proof.revalidated).deep.equals(proof.after)
    expect(proof.allowedEmptyLabels).deep.equals(['Message', 'Message Message'])
    expect((proof.actionReads as unknown[]).length).greaterThan(0)
    expect(proof.send).deep.includes({ enabled: false })
    expect(proof.outcome).equals('passed')
    expect(model.value()).equals('')
    expect(model.calls.filter(call => call === 'type:7777')).has.length(1)
    expect(model.calls.filter(call => call === 'point:270,470')).has.length(2)
    expect(model.calls).not.includes('erase-ACK')
  })
  for (const mode of [
    'retained-aggregated-placeholder',
    'retained-sentinel-name',
    'stale-sentinel',
    'moved-editor',
    'missing-delete'
  ])
    it('rejects complete raw empty-editor proof with ' + mode, async () => {
      const model = editable(mode, '', false, true)
      const failure = await captureFailure(model.actual.replaceDraft(''))
      const proof = model.actual.steps.find(
        step => step.name === 'Observed iOS editor replacement'
      )!
      expect(proof.outcome).equals('failed')
      if (mode === 'retained-aggregated-placeholder') {
        expect(proof.afterCandidate).deep.includes({
          index: 2,
          label: 'Message Message',
          value: 'Message Message',
          text: 'Message Message'
        })
        expect(String(failure)).includes(
          'Fresh editor must expose empty placeholder'
        )
      }
      if (mode === 'retained-sentinel-name')
        expect(proof.afterCandidate).deep.includes({ value: '777' })
      if (mode === 'stale-sentinel')
        expect(String(failure)).includes('Fresh exact sentinel')
      if (mode === 'moved-editor')
        expect(String(failure)).includes('Same editor geometry')
      if (mode === 'missing-delete')
        expect(String(failure)).includes('Observed Delete key')
    })
  it('keeps exact known nonempty replacement strict for complete raw snapshots', async () => {
    const model = editable('dynamic-empty-name', '', false, true)
    await model.actual.replaceDraft('Fresh\nsecond line')
    expect(model.value()).equals('Fresh\nsecond line')
    expect(model.calls).not.includes('type:7777')
    const ambiguous = editable(
      'retained-aggregated-placeholder',
      '',
      false,
      true
    )
    await captureFailure(ambiguous.actual.replaceDraft('Message Message'))
    expect(
      ambiguous.actual.steps.find(
        step => step.name === 'Observed iOS editor replacement'
      )?.outcome
    ).equals('failed')
  })
  it('uses the raw placeholder as the base for an already aggregated empty name', async () => {
    const model = editable('raw-empty-name', '')
    await model.actual.replaceDraft('')
    const proof = model.actual.steps.find(
      step => step.name === 'Observed iOS editor replacement'
    )!
    expect(proof.allowedEmptyLabels).deep.equals(['Message', 'Message Message'])
    expect(proof.outcome).equals('passed')
  })
  for (const mode of [
    'unrelated-empty-name',
    'triple-empty-name',
    'retained-sentinel-name',
    'literal-placeholder-after'
  ])
    it(
      'rejects changed editor identity/value schema and retains its fresh failing node: ' +
        mode,
      async () => {
        const model = editable(mode, 'B', mode === 'literal-placeholder-after')
        await captureFailure(model.actual.replaceDraft(''))
        const proof = model.actual.steps.find(
          step => step.name === 'Observed iOS editor replacement'
        )!
        expect(proof.outcome).equals('failed')
        expect(proof.afterCandidate).equals(
          (proof.editorReads as unknown[]).at(-1)
        )
        if (mode === 'literal-placeholder-after')
          expect(proof.afterCandidate).deep.includes({ value: 'Message' })
      }
    )
  it('verifies exact multiline replacement and keeps attached file/reply context untouched', async () => {
    const model = editable('capped', 'Prior retained draft', true)
    await model.actual.replaceDraft('Fresh\nsecond line')
    expect(model.value()).equals('Fresh\nsecond line')
    expect(model.context).deep.equals({ reply: true, attached: true })
    expect(model.calls).not.includes('type:7777')
  })
  it('observes an explicit at-sign transition without reading a composer hidden by its picker, then verifies Cancel exactly', async () => {
    const model = editable('mention-modal', '', true)
    await model.actual.replaceDraft('')
    const start = model.calls.length
    await model.actual.typeMentionTrigger()
    expect(model.value()).equals('@')
    expect(model.context).deep.equals({ reply: true, attached: true })
    expect(model.calls.slice(start)).deep.equals([
      'type:@',
      'read:chat-picker-scene',
      'read:chat-picker-header',
      'raw'
    ])
    expect(
      model.actual.steps.find(
        step => step.name === 'Typed mention trigger opens member chooser'
      )?.outcome
    ).equals('passed')
    await model.actual.text('Cancel')
    expect(await model.actual.draft()).equals('@')
  })
  it('retains visible selected mention verification after the explicit transition', async () => {
    const model = editable('mention-modal', '')
    await model.actual.typeMentionTrigger()
    await model.actual.id('chat-mention-member-2')
    expect(await model.actual.draft()).equals('@Aaron Judge')
  })
  it('keeps generic replacement strict when an arbitrary at-sign body opens a modal', async () => {
    const model = editable('mention-modal', '')
    await captureFailure(model.actual.replaceDraft('@'))
    expect(model.value()).equals('@')
    expect(
      model.actual.steps.find(
        step => step.name === 'Observed iOS editor replacement'
      )?.outcome
    ).equals('failed')
  })
  for (const mode of [
    'mention-missing-header',
    'mention-missing-search',
    'mention-disabled-search',
    'mention-ambiguous-search'
  ])
    it('rejects an unproved picker transition: ' + mode, async () => {
      const model = editable(mode, '')
      await captureFailure(model.actual.typeMentionTrigger())
      expect(
        model.actual.steps.find(
          step => step.name === 'Typed mention trigger opens member chooser'
        )?.outcome
      ).equals('failed')
    })
  it('uses ordinary supported at-sign input and positive chooser checks on web and Android', async () => {
    for (const surface of ['android', 'web-wide']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.device.inputText = async args => {
        calls.push(['type', args])
      }
      actual.device.assertVisible = async args => {
        calls.push(['visible', args])
      }
      await actual.typeMentionTrigger()
      expect(calls).deep.equals([
        [
          'type',
          { text: '@', ...(surface === 'android' ? { keyPress: true } : {}) }
        ],
        ['visible', { id: 'chat-picker-scene', timeout: 15000 }],
        ['visible', { id: 'chat-picker-header', timeout: 15000 }],
        ['visible', { text: '^Search members$', enabled: true, timeout: 15000 }]
      ])
    }
  })
  it('allows an observed already-selected word without pretending missing Select All guarantees selection', async () => {
    const model = editable('no-select-all')
    await model.actual.replaceDraft('')
    expect(model.value()).equals('')
    expect(model.calls).not.includes('point:50,215')
    const incomplete = editable('missing-menu', 'Two words')
    await captureFailure(incomplete.actual.replaceDraft(''))
    expect(incomplete.value()).not.equals('')
  })
  it('uses actual raw empty editor evidence without rejecting retained reply/file chips', async () => {
    const model = editable('raw', '', true)
    await model.actual.replaceDraft('')
    expect(model.calls).not.includes('hold')
    expect(model.calls).not.includes('type:7777')
    expect(model.context).deep.equals({ reply: true, attached: true })
  })
  it('requires a positive actual attachment when Send remains enabled after clearing', async () => {
    const attached = editable('capped', 'B', true)
    await attached.actual.replaceDraft('')
    expect(attached.calls).includes('read:chat-attachment-chip')
    const wrong = editable('enabled-send')
    await captureFailure(wrong.actual.replaceDraft(''))
    expect(
      wrong.actual.steps.find(
        step => step.name === 'Observed iOS editor replacement'
      )?.outcome
    ).equals('failed')
  })
  for (const [mode, initial] of [
    ['partial-delete', 'Two words'],
    ['retained-text', 'B'],
    ['retained-placeholder', 'Message'],
    ['ambiguous-menu', 'B'],
    ['disabled-menu', 'B'],
    ['missing-delete', 'B'],
    ['disabled-delete', 'B'],
    ['ambiguous-delete', 'B'],
    ['disabled-editor', 'B'],
    ['wrong-id', 'B'],
    ['unknown-send', 'B'],
    ['moved-editor', 'B']
  ])
    it('rejects unproved native editor replacement: ' + mode, async () => {
      const model = editable(mode, initial)
      await captureFailure(model.actual.replaceDraft(''))
      expect(
        model.actual.steps.find(
          step => step.name === 'Observed iOS editor replacement'
        )?.outcome
      ).equals('failed')
    })
  it('does not silently trim or accept native outer whitespace as an exact replacement', async () => {
    const model = editable()
    await captureFailure(model.actual.replaceDraft(' Keep whitespace '))
    expect(model.value()).equals(' Keep whitespace ')
  })
  it('preserves ordinary native erase/type and uses the browser multiline selector', async () => {
    for (const surface of ['android', 'web-wide']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.device.tapOn = async args => {
        calls.push(['focus', args])
      }
      actual.device.eraseText = async args => {
        calls.push(['erase', args])
        value = ''
      }
      actual.device.inputText = async args => {
        calls.push(['type', args])
        value = String(args.text)
      }
      let value = 'Previous draft'
      let browserReads = 0
      actual.dom = async () => {
        browserReads++
        return browserReads === 1
          ? { focused: true, editable: true, value }
          : { focused: true, value, start: 0, end: value.length }
      }
      actual.draft = async () => value
      await actual.replaceDraft('Exact\ntext')
      expect(calls).deep.equals([
        ['focus', { id: 'chat-composer' }],
        ['erase', surface === 'android' ? undefined : { characters: 1 }],
        [
          'type',
          {
            text: 'Exact\ntext',
            ...(surface === 'android'
              ? { keyPress: true }
              : { id: 'chat-composer' })
          }
        ]
      ])
      expect(browserReads).equals(surface === 'android' ? 0 : 2)
    }
  })
  it('uses an exact composer selector for complete multiline browser input', async () => {
    const actual = ui([], 'web-wide')
    let value = ''
    let reads = 0
    const calls: unknown[] = []
    actual.draft = async () => {
      reads++
      return value
    }
    actual.device.inputText = async args => {
      if (args.id !== 'chat-composer')
        throw Error('Key not defined for literal newline')
      calls.push(args)
      value = String(args.text)
    }
    await actual.append('First synthetic line\nSecond synthetic line')
    expect(calls).deep.equals([{ id: 'chat-composer', text: value }])
    expect(reads).equals(2)
    expect(actual.steps[0].outcome).equals('passed')
  })
  it('rejects a nonempty composer before multiline input without replacing existing text', async () => {
    const actual = ui([], 'web-wide')
    actual.draft = async () => 'Retained draft'
    actual.device.inputText = async () => {
      throw Error('Unexpected mutation')
    }
    expect(String(await captureFailure(actual.append('New\nlines')))).contains(
      'actually empty'
    )
    expect(actual.steps[0].outcome).equals('failed')
  })
  it('rejects truncated multiline input and propagates transport failure', async () => {
    for (const fail of [false, true]) {
      const actual = ui([], 'web-wide')
      let value = ''
      actual.draft = async () => value
      actual.device.inputText = async () => {
        if (fail) throw Error('Input transport failed')
        value = 'First line'
      }
      expect(
        String(await captureFailure(actual.append('First line\nSecond line')))
      ).contains(fail ? 'Input transport failed' : 'complete multiline')
      expect(actual.steps[0].outcome).equals('failed')
    }
  })
  it('keeps native multiline and ordinary single-line field input unchanged', async () => {
    for (const [surface, text] of [
      ['web-wide', 'Ordinary search'],
      ['android', 'Native\nlines'],
      ['ios', 'Native\nlines']
    ]) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.draft = async () => {
        throw Error('No composer-specific read for this field')
      }
      actual.device.inputText = async args => {
        calls.push(args)
      }
      await actual.append(text)
      expect(calls).deep.equals([
        { text, ...(surface === 'android' ? { keyPress: true } : {}) }
      ])
    }
  })
  interface AvatarNode {
    type: string
    id?: string
    bounds?: CaptureBox
    children: AvatarNode[]
  }
  function avatarTree(
    box = { x: 10, y: 120, width: 30, height: 30 }
  ): AvatarNode {
    return {
      type: 'FrameLayout',
      children: [
        {
          type: 'ViewGroup',
          id: 'other-row',
          bounds: { x: 10, y: 20, width: 170, height: 70 },
          children: [
            {
              id: 'chat-avatar',
              type: 'ViewGroup',
              bounds: { ...box, y: 30 },
              children: []
            }
          ]
        },
        {
          type: 'ViewGroup',
          id: 'expected-row',
          bounds: { x: 10, y: 110, width: 170, height: 70 },
          children: [
            {
              type: 'ViewGroup',
              children: [
                {
                  id: 'chat-avatar',
                  type: 'ViewGroup',
                  bounds: box,
                  children: []
                }
              ]
            }
          ]
        }
      ]
    }
  }
  const avatarSelector = { id: 'chat-avatar', childOf: { id: 'expected-row' } }
  it('measures the fresh nested Android avatar without copying text or accepting an opaque box', async () => {
    const actual = ui([], 'android')
    let reads = 0
    let copies = 0
    actual.nodes = async () => {
      throw Error('Do not reuse an unscoped flattened observation')
    }
    actual.device.hierarchy = async () => {
      reads++
      return avatarTree()
    }
    actual.device.copyTextFrom = async () => {
      copies++
      return { element: { bounds: { x: 0, y: 0, width: 0, height: 0 } } }
    }
    expect(
      await actual.observedBounds(avatarSelector, 'ViewGroup')
    ).deep.equals({ x: 10, y: 120, width: 30, height: 30 })
    expect(reads).equals(1)
    expect(copies).equals(0)
    const proof = actual.steps[0]
    expect(proof.outcome).equals('passed')
    expect(
      JSON.parse(readFileSync(String(proof.hierarchy), 'utf8'))
    ).deep.equals(avatarTree())
  })
  for (const mode of [
    'missing-parent',
    'duplicate-parent',
    'missing-target',
    'duplicate-target',
    'outside',
    'wrong-type',
    'cycle'
  ])
    it('rejects unproved scoped Android geometry: ' + mode, () => {
      const tree = avatarTree()
      const parent = tree.children[1]
      const target = parent.children[0].children[0]
      if (mode === 'missing-parent') parent.id = 'different'
      if (mode === 'duplicate-parent') tree.children[0].id = 'expected-row'
      if (mode === 'missing-target') parent.children = []
      if (mode === 'duplicate-target') parent.children.push({ ...target })
      if (mode === 'outside')
        target.bounds = { x: 10, y: 300, width: 30, height: 30 }
      if (mode === 'wrong-type') target.type = 'TextView'
      if (mode === 'cycle') target.children = [parent]
      expect(() =>
        androidScopedBounds(tree, avatarSelector, 'ViewGroup')
      ).throws()
    })
  for (const invalid of [undefined, 0, -1, Infinity, NaN])
    it(
      'rejects missing or invalid scoped Android bounds ' + String(invalid),
      () => {
        const tree = avatarTree()
        const target = tree.children[1].children[0].children[0]
        target.bounds =
          invalid == null
            ? undefined
            : { x: 10, y: 120, width: invalid, height: 30 }
        expect(() => androidScopedBounds(tree, avatarSelector)).throws()
      }
    )
  it('retains failed scoped metadata and propagates hierarchy transport errors without clipboard fallback', async () => {
    const actual = ui([], 'android')
    actual.device.copyTextFrom = async () => {
      throw Error('No clipboard fallback')
    }
    actual.device.hierarchy = async () =>
      avatarTree({ x: 10, y: 120, width: 0, height: 30 })
    await captureFailure(actual.observedBounds(avatarSelector))
    expect(actual.steps[0].hierarchy).a('string')
    expect(actual.steps[0].outcome).equals('failed')
    const error = Error('Hierarchy transport failed')
    actual.device.hierarchy = async () => {
      throw error
    }
    expect(await captureFailure(actual.observedBounds(avatarSelector))).equals(
      error
    )
  })
  function photoModel(mode = 'valid'): Chat2UI {
    const actual = ui([], 'android')
    actual.device.hierarchy = async () => avatarTree()
    actual.device.platformInfo = async () => ({
      screenWidth: 200,
      screenHeight: 400
    })
    actual.captureImage = async path => {
      const made = spawnSync(
        process.env.CHAT2_PYTHON ?? 'python3',
        [
          '-c',
          'from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(100,200)); d=ImageDraw.Draw(im); ' +
            (mode === 'valid'
              ? 'd.rectangle((5,60,11,74),fill=(20,220,30)); d.rectangle((12,60,19,74),fill=(220,20,210)); '
              : '') +
            'im.save(sys.argv[1])',
          path
        ],
        { encoding: 'utf8', timeout: 10000 }
      )
      expect(made.status, made.stderr).equals(0)
      return { rawPath: path, width: 100, height: 200 }
    }
    return actual
  }
  it('observes photo colors in the scoped box using actual platform-to-raster scaling', async () => {
    const actual = photoModel()
    const proof = await actual.renderedPhoto(avatarSelector)
    expect(proof.crop).deep.equals({ x: 5, y: 60, width: 15, height: 15 })
    expect(proof.raster).deep.equals({ width: 100, height: 200 })
    expect(proof.actualRenderedSyntheticMarker).equals(true)
    expect(actual.steps[0].outcome).equals('passed')
  })
  it('retains the box, platform, raw capture and pixel result before rejecting missing marker colors', async () => {
    const actual = photoModel('missing-colors')
    expect(
      String(await captureFailure(actual.renderedPhoto(avatarSelector)))
    ).contains('both synthetic')
    const step = actual.steps[0]
    expect(step.box).deep.equals({ x: 10, y: 120, width: 30, height: 30 })
    expect(step.platform).deep.equals({ screenWidth: 200, screenHeight: 400 })
    const saved = JSON.parse(readFileSync(String(step.evidencePath), 'utf8'))
    expect(saved.capture.rawPath).a('string')
    expect(saved.pixelResult.actualRenderedSyntheticMarker).equals(false)
    expect(saved.pixelResult.crop).deep.equals({
      x: 5,
      y: 60,
      width: 15,
      height: 15
    })
    expect(saved.outcome).equals('failed')
  })
  it('opens the real web Attach action before targeting the temporary upload input', async () => {
    const { actual, page } = browserModel()
    const calls: unknown[] = []
    let opened = false
    const prototype = page.window.HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'click')
    const originalClick: unknown = Reflect.get(prototype, 'click')
    actual.text = async label => {
      calls.push(label)
      opened = label === 'Attach'
      const input = page.window.document.createElement('input')
      input.type = 'file'
      page.window.document.body.append(input)
      input.click()
    }
    actual.device.uploadFile = async args => {
      if (!opened) throw Error('No temporary file input before Attach')
      calls.push(args)
      const input = page.window.document.querySelector('input')!
      expect(input.style.display).equals('block')
      Object.defineProperty(input, 'files', {
        value: [new page.window.File(['synthetic'], 'photo.png')]
      })
      input.remove()
    }
    actual.present = async id => {
      calls.push(id)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { files: { photo: '/tmp/synthetic-photo.png' } }
    }) as Scenarios
    await scenario.attachPhoto()
    expect(calls).deep.equals([
      'Attach',
      { css: 'input[type="file"]', path: '/tmp/synthetic-photo.png' },
      'chat-attachment-chip'
    ])
    expect(Reflect.get(prototype, 'click')).equals(originalClick)
    expect(Object.getOwnPropertyDescriptor(prototype, 'click')).deep.equals(
      descriptor
    )
    expect(actual.steps[0].osChooserClaimed).equals(false)
  })
  it('preserves native attachment order and does not upload after a failed web Attach action', async () => {
    const actual = ui([], 'android')
    const calls: unknown[] = []
    actual.device.addMedia = async args => {
      calls.push(['media', args])
    }
    actual.text = async label => {
      calls.push(label)
    }
    actual.device.tapOn = async selector => {
      calls.push(selector)
    }
    actual.present = async id => {
      calls.push(id)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: {
        files: {
          photo: '/tmp/synthetic-photo.png',
          nativePicker: { android: [{ text: 'Observed synthetic photo' }] }
        }
      }
    }) as Scenarios
    await scenario.attachPhoto()
    expect(calls).deep.equals([
      ['media', { files: ['/tmp/synthetic-photo.png'] }],
      'Attach',
      'Photo library',
      { text: 'Observed synthetic photo' },
      'chat-attachment-chip'
    ])
    Object.assign(actual, { native: false })
    const browser = browserModel()
    actual.uploadPhoto = browser.actual.uploadPhoto.bind(browser.actual)
    browser.actual.text = async () => {
      throw Error('Attach action failed')
    }
    actual.text = async () => {
      throw Error('Attach action failed')
    }
    actual.device.uploadFile = async () => {
      throw Error('Unexpected upload')
    }
    expect(String(await captureFailure(scenario.attachPhoto()))).contains(
      'Attach action failed'
    )
    expect(
      (browser.actual.steps[0].restore as { restored: boolean }).restored
    ).equals(true)
  })
  it('restores the exact input descriptor after upload failure and refuses a pre-existing input', async () => {
    for (const existing of [false, true]) {
      const { actual, page } = browserModel()
      const prototype = page.window.HTMLInputElement.prototype
      const before = Object.getOwnPropertyDescriptor(prototype, 'click')
      let uploads = 0
      if (existing) page.window.document.body.innerHTML = '<input type="file">'
      actual.text = async () => {
        const input = page.window.document.createElement('input')
        input.type = 'file'
        page.window.document.body.append(input)
        input.click()
      }
      actual.device.uploadFile = async () => {
        uploads++
        throw Error('Upload failed')
      }
      const error = String(
        await captureFailure(actual.uploadPhoto('/tmp/synthetic.png'))
      )
      expect(error).contains(
        existing ? 'No existing file input' : 'Upload failed'
      )
      expect(uploads).equals(existing ? 0 : 1)
      expect(Object.getOwnPropertyDescriptor(prototype, 'click')).deep.equals(
        before
      )
    }
  })
  it('uses the actual browser clipboard, pastes only its observed synthetic value and restores prior content privately', async () => {
    const { actual, page } = browserModel()
    const prior = 'Unrelated clipboard content must remain private'
    let clipboard = prior
    const inputs: unknown[] = []
    const grants: unknown[] = []
    Object.defineProperty(page.window.navigator, 'clipboard', {
      value: {
        readText: async () => clipboard,
        writeText: async (value: string) => {
          clipboard = value
        }
      }
    })
    actual.device.grantPermissions = async value => {
      grants.push(value)
    }
    actual.device.setClipboard = async () => {
      throw Error('Driver clipboard is not browser clipboard')
    }
    actual.device.pasteText = async () => {
      throw Error('Driver paste is not browser clipboard')
    }
    actual.device.inputText = async value => {
      inputs.push(value)
    }
    try {
      await actual.clipboardSentinel('Synthetic sentinel')
      expect(clipboard).equals('Synthetic sentinel')
      clipboard = 'Actual synthetic copied body'
      await actual.pasteClipboard('Actual synthetic copied body')
      expect(inputs).deep.equals([
        { id: 'chat-composer', text: 'Actual synthetic copied body' }
      ])
      expect(grants).deep.equals([
        {
          origin: 'https://fixture.example.test',
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
        }
      ])
    } finally {
      await actual.restoreClipboard()
    }
    expect(clipboard).equals(prior)
    expect(JSON.stringify(actual.steps)).not.contains(prior)
    expect(
      Object.keys(page.window).some(key => key.startsWith('__chat2Clipboard_'))
    ).equals(false)
  })
  it('does not expose or paste a mismatched clipboard and restores after failed Copy proof', async () => {
    const { actual, page } = browserModel()
    let clipboard = 'Private previous value'
    Object.defineProperty(page.window.navigator, 'clipboard', {
      value: {
        readText: async () => clipboard,
        writeText: async (value: string) => {
          clipboard = value
        }
      }
    })
    actual.device.grantPermissions = async () => {}
    actual.device.inputText = async () => {
      throw Error('Unexpected paste')
    }
    await actual.clipboardSentinel('Synthetic sentinel')
    clipboard = 'Different unrelated value'
    expect(
      String(
        await captureFailure(actual.pasteClipboard('Expected synthetic body'))
      )
    ).contains('Actual app Copy')
    expect(JSON.stringify(actual.steps)).not.contains(
      'Different unrelated value'
    )
    await actual.restoreClipboard()
    expect(clipboard).equals('Private previous value')
  })
  it('submits Send again only with positive error/enabled-Send and an unchanged failed draft', async () => {
    for (const mode of [
      'valid',
      'missing-error',
      'disabled-send',
      'changed-draft'
    ]) {
      const actual = ui([], 'web-wide')
      const calls: unknown[] = []
      let reads = 0
      actual.draft = async () =>
        ++reads > 1 && mode === 'changed-draft'
          ? 'Different draft'
          : 'Failed synthetic draft'
      actual.device.assertVisible = async selector => {
        calls.push(selector)
        if (
          (mode === 'missing-error' && selector.text !== '^Send$') ||
          (mode === 'disabled-send' && selector.enabled === true)
        )
          throw Error('Missing positive retry control')
      }
      actual.text = async label => {
        calls.push(label)
      }
      const scenario = Object.assign(Object.create(Scenarios.prototype), {
        ui: actual,
        observations: []
      }) as Scenarios
      if (mode === 'valid') {
        await scenario.sendAgain()
        expect(calls.at(-1)).equals('Send')
      } else {
        await captureFailure(scenario.sendAgain())
        expect(calls).not.includes('Send')
      }
      expect(calls).not.includes('Retry')
    }
  })
  function browserHistory(mode = 'valid'): {
    actual: Chat2UI
    page: JSDOM
    scenario: Scenarios
    taps: unknown[]
  } {
    const { actual, page } = browserModel()
    const target = {
      id: 'synthetic-old',
      body: 'Older synthetic post',
      authorId: userIdOfGumbo(2),
      seq: 1
    }
    page.window.document.body.innerHTML =
      '<div data-testid="chat-message-history"><button>Load earlier messages</button></div>'
    const history = page.window.document.querySelector('div')!
    Object.defineProperties(history, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 1200 }
    })
    page.window.Element.prototype.scrollIntoView = () => {}
    page.window.Element.prototype.getBoundingClientRect = function () {
      const isBubble =
        this.getAttribute('data-testid')?.startsWith('chat-bubble-') === true
      return {
        x: 0,
        y: isBubble ? 100 : 0,
        width: mode === 'zero' && isBubble ? 0 : 300,
        height: isBubble ? 60 : 600,
        top: 0,
        left: 0,
        right: 300,
        bottom: 600,
        toJSON: () => ({})
      }
    }
    const taps: unknown[] = []
    actual.device.tapOn = async selector => {
      taps.push(selector)
      expect(selector.enabled).equals(true)
      const control = page.window.document.querySelector(String(selector.css))
      expect(control?.textContent).equals('Load earlier messages')
      history.innerHTML =
        '<div data-testid="chat-message-synthetic-old"><div data-testid="chat-bubble-synthetic-old">Older synthetic post</div></div>'
    }
    actual.device.scrollUntilVisible = async () => {
      throw Error('No unscoped browser scroll loop')
    }
    actual.visible = async selector =>
      selector.id === 'chat-pinned-summary' ||
      selector.text === '^Pinned messages$'
    actual.device.pressKey = async selector => {
      taps.push(selector)
    }
    actual.id = async () => {}
    actual.text = async () => {
      throw Error('No ambiguous Cancel backdrop tap')
    }
    actual.present = async id => {
      expect(
        page.window.document.querySelector('[data-testid="' + id + '"]')
      ).not.equals(null)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target } },
      observations: []
    }) as Scenarios
    if (mode === 'missing') history.innerHTML = ''
    if (mode === 'duplicate')
      history.insertAdjacentHTML(
        'afterend',
        '<div data-testid="chat-message-history"></div>'
      )
    return { actual, page, scenario, taps }
  }
  it('dismisses the actual pin popup with Escape and pages through its scoped public earlier control before settling the real target', async () => {
    const { scenario, taps } = browserHistory()
    await scenario.anchor()
    expect(taps[0]).deep.equals({ key: 'ESC' })
    expect(taps).length(2)
    expect(
      scenario.observations.some(
        proof => proof.stableWebAnchor === 'synthetic-old'
      )
    ).equals(true)
  })
  for (const mode of ['missing', 'duplicate', 'zero'])
    it('rejects an unproved browser history target: ' + mode, async () => {
      const { scenario } = browserHistory(mode)
      await captureFailure(scenario.anchor())
    })
  async function blockedWheelReader(mode = ''): Promise<{
    error: unknown
    directions: unknown[]
    offset: number
    scenario: Scenarios
  }> {
    const { actual, page } = browserModel()
    Object.assign(actual, { surface: 'web-touch', native: false })
    page.window.document.body.innerHTML =
      '<div data-testid="chat-message-history"><div data-testid="chat-message-reader"><div data-testid="chat-bubble-reader"><div data-testid="chat-message-body-reader">Ordinary source words</div></div></div><button>Jump to earlier quote</button><input><div id="inner"></div></div>'
    const document = page.window.document
    const history = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-history"]'
    )!
    const row = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-reader"]'
    )!
    const bubble = document.querySelector<HTMLElement>(
      '[data-testid="chat-bubble-reader"]'
    )!
    const body = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-body-reader"]'
    )!
    const quote = document.querySelector('button')!
    const input = document.querySelector('input')!
    const inner = document.querySelector<HTMLElement>('#inner')!
    let offset = 1000
    Object.defineProperties(history, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 5000 },
      scrollTop: {
        get: () => offset,
        set: value => {
          if (mode !== 'stuck') offset = value
        }
      }
    })
    Object.defineProperties(inner, {
      clientHeight: { value: 40 },
      scrollHeight: { value: 80 }
    })
    inner.style.overflowY = 'auto'
    history.getBoundingClientRect = () =>
      new page.window.DOMRect(0, 0, 300, 600)
    const shifted = (y: number, height: number): DOMRect =>
      new page.window.DOMRect(48, y - (offset - 1000), 200, height)
    row.getBoundingClientRect = bubble.getBoundingClientRect = () =>
      shifted(114, 90)
    body.getBoundingClientRect = () => shifted(130, 56)
    quote.getBoundingClientRect = () => shifted(280, 40)
    document.elementFromPoint = (_x, y) => {
      if (mode === 'input') return input
      if (mode === 'inner') return inner
      const q = quote.getBoundingClientRect()
      if (y >= q.top && y <= q.bottom) return quote
      const b = body.getBoundingClientRect()
      return y >= b.top && y <= b.bottom ? body : history
    }
    const directions: unknown[] = []
    actual.device.scroll = async command => {
      directions.push(command.direction)
      history.scrollTop += command.direction === 'DOWN' ? 300 : -300
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: { id: 'reader' } } },
      observations: []
    }) as Scenarios
    let error: unknown
    try {
      await scenario.ownWebReader(scenario.f.messages.target)
    } catch (failure) {
      error = failure
    }
    return { error, directions, offset, scenario }
  }
  it('positions the exact noninteractive body before genuine balanced wheels when the fixed point initially hits a quote Button', async () => {
    const result = await blockedWheelReader()
    expect(result.error).equals(undefined)
    expect(result.directions).deep.equals(['DOWN', 'UP'])
    expect(result.offset).equals(858)
    const proof = result.scenario.observations[0]
    expect(
      (proof.noninteractiveWheelSetup as Record<string, unknown>).positioned
    ).equals(true)
  })
  for (const mode of ['stuck', 'input', 'inner'])
    it(
      'retains the real wheel interception guard after unproved body setup: ' +
        mode,
      async () => {
        const result = await blockedWheelReader(mode)
        expect(String(result.error)).includes(
          'Interactive or inner-scroll wheel interception'
        )
        expect(result.directions).deep.equals([])
      }
    )
  it('establishes genuine balanced wheel movement before accepting the unchanged reader zero', async () => {
    const { scenario, actual, page } = browserHistory()
    await scenario.anchor()
    const history = page.window.document.querySelector(
      '[data-testid="chat-message-history"]'
    )!
    page.window.document.elementFromPoint = () => history
    const bubble = page.window.document.querySelector(
      '[data-testid="chat-bubble-synthetic-old"]'
    )!
    bubble.getBoundingClientRect = () => ({
      x: 0,
      y: 100 - history.scrollTop,
      width: 300,
      height: 60,
      top: 100 - history.scrollTop,
      bottom: 160 - history.scrollTop,
      left: 0,
      right: 300,
      toJSON: () => ({})
    })
    const directions: unknown[] = []
    actual.device.scroll = async command => {
      directions.push(command.direction)
      history.scrollTop += command.direction === 'DOWN' ? 300 : -300
    }
    await scenario.ownWebReader(scenario.f.messages.target, true)
    expect(directions).deep.equals(['DOWN', 'UP'])
    expect(history.scrollTop).equals(0)
    page.window.document.elementFromPoint = () => page.window.document.body
    await captureFailure(
      scenario.ownWebReader(scenario.f.messages.target, true)
    )
    expect(directions).length(2)
  })
  it('uses the real semantic emoji Button raw glyph instead of matching a Search input value', async () => {
    const { actual, page } = browserModel()
    page.window.document.body.innerHTML =
      '<input value="thumbs up"><div role="button" aria-label="thumbs up">👍️</div>'
    const button = page.window.document.querySelector('[role="button"]')!
    ;(button as HTMLElement).style.opacity = '1'
    button.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      top: 10,
      left: 10,
      right: 50,
      bottom: 50,
      toJSON: () => ({})
    })
    page.window.document.elementFromPoint = () => button
    const calls: unknown[] = []
    actual.device.tapOn = async selector => {
      calls.push(selector)
      return { element: { text: '👍️' } }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId: userIdOfGumbo(1),
      observations: []
    }) as Scenarios
    expect(await scenario.pickThumbsUp()).equals('👍️')
    expect(calls).deep.equals([
      {
        css: '[role="button"][aria-label="thumbs up"]',
        enabled: true,
        timeout: 5000
      }
    ])
    button.insertAdjacentHTML('afterend', button.outerHTML)
    await captureFailure(scenario.pickThumbsUp())
    expect(calls).length(1)
  })
  function incomingModel(mode = 'valid'): {
    scenario: Scenarios
    actual: Chat2UI
    calls: string[]
  } {
    const actual = ui([], 'web-wide')
    const calls: string[] = []
    const current = message({
      id: 'run-first',
      seq: 1,
      senderUserId: userIdOfGumbo(2),
      mine: true,
      body: 'First incoming row'
    })
    const end = message({
      id: 'run-last',
      seq: 2,
      senderUserId: userIdOfGumbo(2),
      mine: true,
      body: 'Final incoming row'
    })
    const boundary = message({
      id: 'own-boundary',
      seq: 3,
      senderUserId: userIdOfGumbo(1),
      mine: false,
      body: 'Different sender boundary'
    })
    const observed =
      mode === 'no-incoming'
        ? [boundary]
        : mode === 'tail'
          ? [current, end]
          : [current, end, boundary]
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'conversation',
      viewerId: userIdOfGumbo(1),
      observations: []
    }) as Scenarios
    scenario.protocolPeer = async () =>
      ({
        engine: {
          open: async () => {
            calls.push('fresh-peer-view')
            if (mode === 'transport') throw Error('Verified peer unavailable')
            return { messages: observed }
          }
        }
      }) as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>
    scenario.anchor = async target => {
      if (target == null) throw Error('Actual anchor target required')
      calls.push('anchor:' + target.id)
    }
    scenario.targetBounds = async id => {
      calls.push(id)
      if (id === 'chat-avatar-lane-run-first')
        throw Error('Empty nonterminal lane has zero height')
      if (id.startsWith('chat-avatar-lane-'))
        return { x: 10, y: 252, width: 28, height: 28 }
      const first = id.endsWith('run-first')
      return {
        x: id.startsWith('chat-bubble-')
          ? mode === 'missing-space'
            ? 10
            : 42
          : 10,
        y: first ? 100 : 200,
        width: id.startsWith('chat-bubble-') ? 180 : 250,
        height: first ? 60 : 80
      }
    }
    scenario.readingBand = async () => ({
      top: 60,
      bottom: mode === 'occluded' ? 270 : 600
    })
    actual.observedBounds = async selector => {
      expect(selector).deep.equals({
        id: 'chat-avatar',
        childOf: { id: 'chat-avatar-lane-run-last' }
      })
      if (mode === 'ambiguous') throw Error('Duplicate actual scoped avatar')
      return {
        x: mode === 'right' ? 60 : 10,
        y: mode === 'not-bottom' ? 240 : 252,
        width: mode === 'missing-avatar' ? 0 : 28,
        height: 28
      }
    }
    actual.shot = async kind => {
      calls.push('shot:' + kind)
    }
    return { scenario, actual, calls }
  }
  it('measures incoming horizontal reservation without demanding a repeated avatar or positive empty-lane height', async () => {
    const { scenario, calls } = incomingModel()
    const reservation = await scenario.incomingReservation({
      id: 'run-first',
      seq: 1,
      body: 'First incoming row',
      authorId: userIdOfGumbo(2)
    })
    expect(reservation.width).equals(32)
    expect(calls).not.includes('chat-avatar-lane-run-first')
    await scenario.incomingRunEndAvatar([reservation])
    expect(calls).includes('chat-avatar-lane-run-last')
    expect(calls).includes('shot:incoming-run-avatar')
  })
  it('uses a fresh verified current run ending and sender identity independent of the peer mine flag', async () => {
    for (const mode of ['valid', 'tail']) {
      const { scenario, actual, calls } = incomingModel(mode)
      await scenario.incomingRunEndAvatar([])
      expect(calls[0]).equals('fresh-peer-view')
      expect(actual.steps[0].outcome).equals('passed')
      const boundary = actual.steps[0].boundary as {
        current: { id: string }
        next: unknown
      }
      expect(boundary.current.id).equals('run-last')
      expect(boundary.next == null).equals(mode === 'tail')
    }
  })
  for (const mode of [
    'no-incoming',
    'transport',
    'missing-avatar',
    'ambiguous',
    'right',
    'not-bottom',
    'occluded'
  ])
    it('rejects an unproved actual run-ending avatar: ' + mode, async () => {
      const { scenario, actual, calls } = incomingModel(mode)
      await captureFailure(scenario.incomingRunEndAvatar([]))
      expect(actual.steps[0].outcome).equals('failed')
      expect(calls).not.includes('shot:incoming-run-avatar')
    })
  it('rejects a missing incoming reservation or a lane width lost in another row', async () => {
    const missing = incomingModel('missing-space')
    await captureFailure(
      missing.scenario.incomingReservation({
        id: 'run-first',
        seq: 1,
        body: 'First row',
        authorId: userIdOfGumbo(2)
      })
    )
    const model = incomingModel()
    const reserved = await model.scenario.incomingReservation({
      id: 'run-first',
      seq: 1,
      body: 'First row',
      authorId: userIdOfGumbo(2)
    })
    await captureFailure(
      model.scenario.incomingRunEndAvatar([{ ...reserved, width: 4 }])
    )
    expect(model.actual.steps[0].outcome).equals('failed')
  })
  it('selects the exact actionable pin row instead of duplicate inert background text', async () => {
    const actual = ui([], 'web-wide')
    const calls: string[] = []
    const pins = [{ messageId: 'target' }, { messageId: 'other' }]
    actual.id = async id => {
      calls.push(id)
    }
    actual.text = async () => {
      throw Error('Matching background text has pointer-events none')
    }
    actual.present = async () => {}
    actual.shot = async () => {}
    actual.device.swipe = async () => {}
    actual.device.assertVisible = async () => {}
    const observations: Array<Record<string, unknown>> = []
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'conversation',
      observations,
      f: {
        messages: { target: { id: 'target', body: 'Duplicate pinned body' } }
      }
    }) as Scenarios
    scenario.openGroup = async () => {}
    scenario.anchor = async () => {}
    scenario.readable = async () => {}
    const client = { chatPins: async () => pins }
    scenario.client = async () =>
      client as unknown as Awaited<ReturnType<Scenarios['client']>>
    scenario.check = async (name, run) => {
      if (
        name ===
        'E6 personal floating pins, verified clear target and same-user state'
      )
        await run()
    }
    await scenario.E6()
    expect(calls).deep.equals(['chat-pinned-summary', 'chat-pin-target'])
    expect(observations[0]).deep.equals({ seededPersonalPinsRestored: [] })
  })

  it('restores a removed seeded personal pin through the API before E6 reads its pins', async () => {
    const actual = ui([], 'web-wide')
    actual.id = async () => {}
    actual.present = async () => {}
    actual.shot = async () => {}
    actual.device.swipe = async () => {}
    actual.device.assertVisible = async () => {}
    const observations: Array<Record<string, unknown>> = []
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'conversation',
      observations,
      f: {
        messages: {
          target: { id: 'target', body: 'Pinned target' },
          long: { id: 'long', body: 'Long pinned body' }
        }
      }
    }) as Scenarios
    const order: string[] = []
    scenario.openGroup = async () => {
      order.push('open')
    }
    scenario.anchor = async () => {}
    scenario.readable = async () => {}
    const pins = [{ messageId: 'target' }]
    const client = {
      chatPins: async () => pins.map(pin => ({ ...pin })),
      pinChatMessage: async (group: string, id: string, pinned: boolean) => {
        order.push('pin ' + group + ' ' + id + ' ' + String(pinned))
        pins.push({ messageId: id })
      }
    }
    scenario.client = async () =>
      client as unknown as Awaited<ReturnType<Scenarios['client']>>
    scenario.check = async (name, run) => {
      if (
        name ===
        'E6 personal floating pins, verified clear target and same-user state'
      )
        await run()
    }
    await scenario.E6()
    expect(order.slice(0, 2)).deep.equals([
      'pin conversation long true',
      'open'
    ])
    expect(observations[0]).deep.equals({
      seededPersonalPinsRestored: ['long']
    })
  })
  function olderReader(mode = 'valid'): {
    scenario: Scenarios
    actual: Chat2UI
    calls: unknown[]
  } {
    const actual = ui([], 'web-wide')
    const calls: unknown[] = []
    let offset = 900
    let scrolled = false
    actual.dom = async script => {
      expect(script).not.contains('scrollTop=')
      expect(script).contains('document.elementFromPoint')
      return {
        offset: mode === 'invalid' ? NaN : offset,
        maximum: mode === 'resize' && scrolled ? 1100 : 1000,
        height: 200,
        wheelPointInside: mode !== 'wrong-hit'
      }
    }
    actual.device.scroll = async args => {
      calls.push(args)
      if (mode === 'transport') throw Error('Wheel transport failed')
      scrolled = true
      if (mode !== 'no-motion') offset -= mode === 'short' ? 10 : 300
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      observations: []
    }) as Scenarios
    return { scenario, actual, calls }
  }
  it('establishes older-reader intent with an ordinary Maestro wheel and positive public movement', async () => {
    const { scenario, actual, calls } = olderReader()
    await scenario.olderWebReader()
    expect(calls).deep.equals([{ direction: 'UP' }])
    expect(actual.steps[0].outcome).equals('passed')
    expect(actual.steps[0].samples).deep.equals([
      {
        before: { offset: 900, maximum: 1000, height: 200 },
        after: { offset: 600, maximum: 1000, height: 200 },
        command: { direction: 'UP' }
      }
    ])
  })
  for (const mode of [
    'wrong-hit',
    'invalid',
    'resize',
    'transport',
    'no-motion',
    'short'
  ])
    it(
      'does not postulate older-reader intent from invalid or unchanged geometry: ' +
        mode,
      async () => {
        const { scenario, actual, calls } = olderReader(mode)
        await captureFailure(scenario.olderWebReader())
        expect(actual.steps[0].outcome).equals('failed')
        expect(calls.length).at.most(4)
        if (mode === 'wrong-hit' || mode === 'invalid')
          expect(calls).deep.equals([])
      }
    )
  function visibleReader(mode = 'valid'): {
    scenario: Scenarios
    actual: Chat2UI
    advance: () => void
    reads: () => number
  } {
    const actual = ui([], 'web-wide')
    let phase = 0
    let reads = 0
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      observations: []
    }) as Scenarios
    scenario.readingBand = async () => ({ top: 60, bottom: 500 })
    actual.nodes = async scope => {
      expect(scope).equals('chat-message-history')
      reads++
      const body: PublicNode = {
        id:
          phase > 0 && mode === 'missing'
            ? 'chat-message-body-other'
            : 'chat-message-body-visible',
        bounds: {
          x: mode === 'horizontal' ? 500 : 40,
          y:
            mode === 'tall-sliver'
              ? 461
              : mode === 'tall' || mode === 'tall-moved'
                ? -700 + (phase > 0 && mode === 'tall-moved' ? 4 : 0)
                : mode === 'offscreen'
                  ? 1100
                  : mode === 'occluded'
                    ? 59
                    : 120 + (phase > 0 && mode === 'moved' ? 4 : 0),
          width: 160,
          height: mode === 'zero' ? 0 : mode.startsWith('tall') ? 1200 : 40
        }
      }
      return [
        {
          id: 'chat-message-history',
          bounds: { x: 20, y: 0, width: 280, height: 600 }
        },
        {
          id: 'chat-pin-visible',
          bounds: { x: 40, y: 70, width: 160, height: 40 }
        },
        {
          id: 'chat-message-body-offscreen',
          bounds: { x: 40, y: 1200 + phase * 17, width: 160, height: 900 }
        },
        body,
        ...(mode === 'ambiguous' ? [{ ...body }] : [])
      ]
    }
    scenario.targetBounds = async () => {
      throw Error('No offscreen-target geometry fallback')
    }
    actual.device.tapOn = async () => {
      throw Error('No scrolling or UI action during reader observation')
    }
    return {
      scenario,
      actual,
      advance: () => {
        phase++
      },
      reads: () => reads
    }
  }
  it('compares a genuine visible body and ignores layout changes of an offscreen tail', async () => {
    const model = visibleReader()
    const before = await model.scenario.visibleReaderAnchor()
    expect(before.id).equals('chat-message-body-visible')
    model.advance()
    const after = await model.scenario.visibleReaderAnchor(
      before,
      'Background discovery must not move visible reader'
    )
    expect(after.bounds).deep.equals(before.bounds)
    expect(model.reads()).equals(2)
    expect(model.actual.steps.every(step => step.outcome === 'passed')).equals(
      true
    )
    expect(model.scenario.observations.length).equals(2)
  })
  it('certifies a genuinely intersecting tall body independently of leading-edge attention consumption', async () => {
    const model = visibleReader('tall')
    const before = await model.scenario.visibleReaderAnchor()
    expect(before.bounds.y).equals(-700)
    model.advance()
    expect(
      (await model.scenario.visibleReaderAnchor(before)).bounds
    ).deep.equals(before.bounds)
    const moved = visibleReader('tall-moved')
    const original = await moved.scenario.visibleReaderAnchor()
    moved.advance()
    expect(
      String(await captureFailure(moved.scenario.visibleReaderAnchor(original)))
    ).contains('Actual visible reader must not move')
  })
  for (const mode of [
    'offscreen',
    'occluded',
    'tall-sliver',
    'zero',
    'ambiguous',
    'horizontal'
  ])
    it(
      'rejects an unproved visible message-body reader anchor: ' + mode,
      async () => {
        const { scenario, actual } = visibleReader(mode)
        await captureFailure(scenario.visibleReaderAnchor())
        expect(actual.steps[0].outcome).equals('failed')
      }
    )
  it('retains exact before and after boxes before rejecting a four-pixel visible-reader movement', async () => {
    const model = visibleReader('moved')
    const before = await model.scenario.visibleReaderAnchor()
    model.advance()
    expect(
      String(
        await captureFailure(
          model.scenario.visibleReaderAnchor(
            before,
            'Background discovery must not move visible reader'
          )
        )
      )
    ).contains('Background discovery must not move visible reader')
    const proof = model.actual.steps[1]
    expect(proof.outcome).equals('failed')
    expect(proof.before).deep.equals(before)
    expect(proof.anchor).deep.equals({
      ...before,
      bounds: { ...before.bounds, y: 124 }
    })
    expect(model.scenario.observations[1].visibleReaderAnchor).equals(proof)
  })
  it('never replaces a lost original visible reader with a different current body', async () => {
    const model = visibleReader('missing')
    const before = await model.scenario.visibleReaderAnchor()
    model.advance()
    await captureFailure(model.scenario.visibleReaderAnchor(before))
    expect(model.actual.steps[1].outcome).equals('failed')
  })
  it('reads the actual unique Button instead of a large identically labelled wrapper', () => {
    const result = iosPublicRead(
      raw([
        node(0, 'ScrollView', {
          rect: { x: 0, y: 0, width: 300, height: 600 }
        }),
        node(1, 'Other', {
          parentIndex: 0,
          identifier: 'members',
          rect: { x: 0, y: 10, width: 300, height: 500 }
        }),
        node(2, 'Other', {
          parentIndex: 0,
          label: 'Safety number with Member Z',
          rect: { x: 0, y: 20, width: 300, height: 450 }
        }),
        node(3, 'Button', {
          parentIndex: 2,
          label: 'Safety number with Member Z'
        })
      ]),
      { text: '^Safety number with Member Z$', childOf: { id: 'members' } },
      'Button'
    )
    expect(result.element?.index).equals(3)
  })
  it('rejects ambiguous Buttons rather than choosing the first duplicate name', () => {
    expect(() =>
      iosPublicRead(
        raw([
          node(0, 'Button', { label: 'Same' }),
          node(1, 'Button', { label: 'Same' })
        ]),
        { text: '^Same$' },
        'Button'
      )
    ).throws('Unique exact')
  })
  for (const invalid of [0, -1, Infinity, NaN])
    it('rejects invalid measured native geometry ' + String(invalid), () => {
      expect(() =>
        iosPublicRead(
          raw([
            node(0, 'Button', {
              identifier: 'item',
              rect: { ...box, width: invalid }
            })
          ]),
          { id: 'item' }
        )
      ).throws()
    })
  it('rejects a matching row outside its observed scope', () => {
    expect(
      iosPublicRead(
        raw([
          node(0, 'Other', { identifier: 'scope' }),
          node(1, 'Button', { label: 'Row', rect: { ...box, y: 300 } })
        ]),
        { text: '^Row$', childOf: { id: 'scope' } },
        'Button'
      ).element
    ).equals(undefined)
  })
  it('rejects a cyclic actual ancestry', () => {
    expect(() =>
      iosPublicRead(
        raw([
          node(0, 'Other', { identifier: 'scope', parentIndex: 1 }),
          node(1, 'Button', { label: 'Row', parentIndex: 0 })
        ]),
        { text: '^Row$', childOf: { id: 'scope' } },
        'Button'
      )
    ).throws()
  })
  it('uses a supported positive exact-ID deep response when the raw tree is capped', async () => {
    const actual = ui([])
    let called = 0
    actual.device.assertVisible = async args => {
      called++
      expect(args.id).equals('item')
      return {
        element: {
          id: 'item',
          class: 'Button',
          text: 'Actual',
          bounds: box,
          enabled: true
        }
      }
    }
    expect(await actual.publicBounds('item')).deep.equals(box)
    expect(called).equals(1)
    expect(await actual.publicText('item')).equals('Actual')
  })
  it('rejects wrong-ID deep responses and propagates read errors', async () => {
    const actual = ui([])
    actual.device.assertVisible = async () => ({
      element: { id: 'other', bounds: box }
    })
    try {
      await actual.publicBounds('item')
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('Exact returned')
    }
    actual.device.assertVisible = async () => {
      throw Error('Transport failure')
    }
    try {
      await actual.publicBounds('item')
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('Transport failure')
    }
  })
  it('never substitutes a label for an empty or ambiguous editable draft', async () => {
    const actual = ui([
      node(0, 'TextView', {
        identifier: 'chat-composer',
        label: 'Message',
        placeholderValue: 'Message'
      })
    ])
    try {
      await actual.draft()
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('ambiguous')
    }
    actual.device.hierarchy = async () => {
      throw Error('Unsupported read')
    }
    const nonempty = ui([
      node(0, 'TextView', {
        identifier: 'chat-composer',
        label: 'Message',
        value: 'Actual\nsecond line'
      })
    ])
    expect(await nonempty.draft()).equals('Actual\nsecond line')
  })
  it('keeps the Android copyTextFrom path unchanged', async () => {
    const actual = ui([], 'android')
    actual.device.copyTextFrom = async () => ({
      data: 'Android draft',
      element: { bounds: box }
    })
    expect(await actual.draft()).equals('Android draft')
    expect(await actual.publicText('item')).equals('Android draft')
  })
  it('requires the actual observed OS menu item before tapping Copy', async () => {
    const actual = ui([
      node(0, 'Button', { label: 'Copy' }),
      node(1, 'MenuItem', { label: 'Copy' })
    ])
    const tapped: unknown[] = []
    actual.device.tapOnPoint = async args => {
      tapped.push(args)
    }
    await actual.iosMenuAction('Copy')
    expect(tapped).deep.equals([{ x: 110, y: 40 }])
    try {
      await actual.iosMenuAction('Paste')
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('Observed exact OS')
    }
    expect(tapped.length).equals(1)
  })
  it('observes Delete inside the actual Keyboard and uses an ordinary point tap', async () => {
    const actual = ui([
      node(0, 'Keyboard', { rect: { x: 0, y: 400, width: 300, height: 200 } }),
      node(1, 'Key', {
        label: 'delete',
        rect: { x: 250, y: 450, width: 40, height: 40 }
      })
    ])
    const tapped: unknown[] = []
    actual.device.tapOnPoint = async args => {
      tapped.push(args)
    }
    await actual.deleteBackward()
    expect(tapped).deep.equals([{ x: 270, y: 470 }])
  })
  it('rejects an absent or disabled Delete key without issuing BACKSPACE', async () => {
    for (const nodes of [
      [],
      [node(0, 'Key', { label: 'delete', enabled: false })]
    ]) {
      const actual = ui(nodes)
      try {
        await actual.deleteBackward()
        throw Error('Unexpected success')
      } catch (error) {
        expect(String(error)).not.contains('Unexpected success')
      }
    }
  })
  it('keeps non-iOS clipboard, backspace and recording calls unchanged', async () => {
    const actual = ui([], 'android')
    const calls: unknown[] = []
    actual.device.setClipboard = async args => {
      calls.push(['set', args])
    }
    actual.device.pasteText = async () => {
      calls.push('paste')
    }
    actual.device.pressKey = async args => {
      calls.push(['key', args])
    }
    actual.device.startRecording = async args => {
      calls.push(['start', args])
    }
    actual.device.stopRecording = async () => {
      calls.push('stop')
    }
    await actual.clipboardSentinel('sentinel')
    await actual.pasteClipboard()
    await actual.deleteBackward()
    await actual.recordTransition('movie.mp4', async () => {
      calls.push('work')
    })
    expect(calls).deep.equals([
      ['set', { text: 'sentinel' }],
      'paste',
      ['key', { key: 'BACKSPACE' }],
      ['start', { path: 'movie.mp4' }],
      'work',
      'stop'
    ])
  })
  it('uses exact positive deep text metadata without unsupported copy operations', async () => {
    const actual = ui([])
    actual.device.assertVisible = async args => {
      expect(args.text).equals('Send')
      return {
        element: {
          text: 'Send',
          accessibilityLabel: 'Send',
          class: 'Button',
          bounds: box,
          enabled: false
        }
      }
    }
    expect(
      await actual.observedBounds({ text: '^Send$' }, 'Button')
    ).deep.equals(box)
    actual.device.assertVisible = async () => ({
      element: {
        accessibilityLabel: 'Other Send',
        class: 'Button',
        bounds: box
      }
    })
    try {
      await actual.observedBounds({ text: '^Send$' }, 'Button')
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('Exact returned')
    }
  })
  it('proves empty UI from actual placeholder, disabled Send and unchanged frame', async () => {
    const nodes = [
      node(0, 'TextView', {
        identifier: 'chat-composer',
        label: 'Message',
        placeholderValue: 'Message'
      }),
      node(1, 'Other', {
        identifier: 'chat-composer-band',
        rect: { x: 0, y: 0, width: 300, height: 100 }
      }),
      node(2, 'Button', { label: 'Send', enabled: false })
    ]
    const actual = ui(nodes)
    actual.device.screenshot = async () => captureImages[0]
    await actual.assertEmptyDraft()
    expect(actual.steps.at(-1)?.name).equals('Actual native empty composer UI')
    for (const extra of [
      { value: 'Old account draft' },
      { placeholderValue: undefined },
      { enabled: false }
    ]) {
      actual.device = {
        hierarchyRaw: async () =>
          raw([{ ...nodes[0], ...extra }, ...nodes.slice(1)])
      } as unknown as Chat2UI['device']
      try {
        await actual.assertEmptyDraft()
        throw Error('Unexpected success')
      } catch (error) {
        expect(String(error)).not.contains('Unexpected success')
      }
    }
  })
  it('rejects enabled Send, retained reply and capped empty-state snapshots', async () => {
    const base = [
      node(0, 'TextView', {
        identifier: 'chat-composer',
        placeholderValue: 'Message'
      }),
      node(1, 'Other', {
        identifier: 'chat-composer-band',
        rect: { x: 0, y: 0, width: 300, height: 100 }
      }),
      node(2, 'Button', { label: 'Send', enabled: false })
    ]
    for (const nodes of [
      [...base.slice(0, 2), { ...base[2], enabled: true }],
      [...base, node(3, 'Button', { label: 'Cancel reply' })],
      [...base, ...Array.from({ length: 297 }, (_, i) => node(i + 3, 'Other'))]
    ]) {
      const actual = ui(nodes)
      try {
        await actual.assertEmptyDraft()
        throw Error('Unexpected success')
      } catch (error) {
        expect(String(error)).not.contains('Unexpected success')
      }
    }
  })
  it('runs the real E5 movement callback with documented endpoints and a sub-hold delay', async () => {
    const actual = ui([])
    const calls: unknown[] = []
    let reacted = false
    actual.absent = async id => {
      calls.push(id)
    }
    actual.text = async () => {
      reacted = !reacted
    }
    actual.device.dragAndDrop = async args => {
      calls.push(args)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: { id: 'synthetic-target' } } },
      group: 'synthetic',
      viewerId: userIdOfGumbo(1),
      observations: []
    }) as Scenarios
    scenario.check = async (name, work) => {
      if (name.startsWith('E5 movement before hold')) await work()
    }
    scenario.anchor = async () => {}
    scenario.targetBounds = async () => box
    scenario.action = async () => {}
    scenario.protocolPeer = async () =>
      ({
        engine: {
          open: async () => ({
            messages: [
              {
                id: 'synthetic-target',
                status: 'ok',
                reactions: reacted
                  ? [{ emoji: '👍', userIds: [userIdOfGumbo(1)] }]
                  : []
              }
            ]
          })
        }
      }) as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>
    await scenario.E5()
    expect(calls[0]).deep.equals({
      from: { point: '20,30' },
      to: { point: '20,90' },
      holdDuration: 50,
      duration: 200
    })
    expect(calls[1]).equals('chat-message-spotlight')
  })
  it('does not accept a different raw reaction glyph or another viewer reaction', async () => {
    for (const reaction of [
      { emoji: '👍️', userIds: [userIdOfGumbo(1)] },
      { emoji: '👍', userIds: [userIdOfGumbo(2)] }
    ]) {
      const actual = ui([])
      actual.absent = async () => {}
      actual.text = async () => {}
      actual.device.dragAndDrop = async () => {}
      const scenario = Object.assign(Object.create(Scenarios.prototype), {
        ui: actual,
        f: { messages: { target: { id: 'synthetic-target' } } },
        group: 'synthetic',
        viewerId: userIdOfGumbo(1),
        observations: []
      }) as Scenarios
      scenario.check = async (name, work) => {
        if (name.startsWith('E5 movement before hold')) await work()
      }
      scenario.anchor = async () => {}
      scenario.targetBounds = async () => box
      scenario.action = async () => {}
      const now = Date.now
      let elapsed = 0
      let reads = 0
      const peer = {
        engine: {
          open: async () => {
            if (++reads > 1) elapsed += 30001
            return {
              messages: [
                { id: 'synthetic-target', status: 'ok', reactions: [reaction] }
              ]
            }
          }
        }
      }
      scenario.protocolPeer = async () =>
        peer as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>
      Date.now = () => now() + elapsed
      try {
        expect(String(await captureFailure(scenario.E5()))).contains(
          'Actual selected raw glyph and reacting viewer'
        )
        expect(reads).equals(4)
      } finally {
        Date.now = now
      }
    }
  })
  function recorder(
    actual: Chat2UI,
    mode: string,
    calls: unknown[]
  ): (command: string, args: string[]) => ChildProcess {
    return (command, args) => {
      expect(command).equals('/usr/bin/xcrun')
      expect(args.slice(0, 3)).deep.equals(['simctl', 'io', 'owned-simulator'])
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        stderr: PassThrough
        kill: (signal: string) => boolean
      }
      child.pid = 123
      child.stderr = new PassThrough()
      child.kill = signal => {
        calls.push(signal)
        if (mode !== 'missing-file')
          writeFileSync(args.at(-1)!, Buffer.alloc(64))
        queueMicrotask(() =>
          child.emit('close', mode === 'bad-exit' ? 1 : 0, null)
        )
        return true
      }
      queueMicrotask(() =>
        mode === 'no-ack'
          ? child.emit('close', 1, null)
          : child.stderr.emit('data', Buffer.from('Recording started'))
      )
      if (mode === 'early-exit')
        queueMicrotask(() => child.emit('close', 0, null))
      return child as unknown as ChildProcess
    }
  }
  for (const surface of ['web-wide', 'web-touch', 'ios', 'android'])
    it(
      'routes all variant sweeps without unsupported web recording while retaining native light/reduced clips: ' +
        surface,
      async () => {
        const native = surface === 'ios' || surface === 'android'
        const variants: string[] = []
        const transitions: string[] = []
        const recordings: string[] = []
        const reached = new Error('Original transition action reached')
        let current = ''
        const actual = {
          native,
          surface,
          runDir: '/tmp/synthetic-variant',
          present: async () => {},
          shot: async () => {},
          variant: async (name: string, work: () => Promise<void>) => {
            current = name
            variants.push(name)
            await work()
          },
          recordTransition: async (
            _path: string,
            work: () => Promise<void>
          ) => {
            if (!native) throw Error('Browser recording is unsupported')
            recordings.push(current)
            await work()
          }
        }
        const scenario = Object.assign(Object.create(Scenarios.prototype), {
          ui: actual,
          f: { messages: { target: { id: 'target' } } },
          observations: [],
          signIn: async () => {},
          openGroup: async () => {},
          anchor: async () => {},
          readable: async () => {},
          check: async (_name: string, work: () => Promise<void>) => {
            try {
              await work()
            } catch (error) {
              if (error !== reached) throw error
            }
          },
          action: async () => {
            transitions.push(current)
            throw reached
          }
        }) as Scenarios
        await scenario.variants()
        expect(variants).deep.equals([
          'light',
          'dark',
          'large-text',
          'reduced-motion',
          'reduced-transparency'
        ])
        expect(transitions).deep.equals(variants)
        expect(recordings).deep.equals(
          native ? ['light', 'reduced-motion'] : []
        )
      }
    )
  it('records only after the actual first-frame marker and finalizes before probing', async () => {
    const actual = ui([])
    const calls: unknown[] = []
    Object.assign(actual, {
      deviceId: 'owned-simulator',
      fixture: { devices: { ios: { id: 'owned-simulator' } } }
    })
    const path = join(actual.runDir, 'movie.mp4')
    await actual.recordTransition(
      path,
      async () => {
        calls.push('work')
      },
      recorder(actual, 'valid', calls),
      file => {
        expect(file).equals(path)
        calls.push('probe')
        return { duration: 1 }
      }
    )
    expect(calls).deep.equals(['work', 'SIGINT', 'probe'])
    expect(actual.steps.at(-1)?.exitCode).equals(0)
  })
  for (const mode of ['no-ack', 'bad-exit', 'missing-file', 'early-exit'])
    it(
      'rejects recorder ' + mode + ' without a successful video claim',
      async () => {
        const actual = ui([])
        const calls: unknown[] = []
        Object.assign(actual, {
          deviceId: 'owned-simulator',
          fixture: { devices: { ios: { id: 'owned-simulator' } } }
        })
        try {
          await actual.recordTransition(
            join(actual.runDir, 'movie.mp4'),
            async () => {
              calls.push('work')
            },
            recorder(actual, mode, calls),
            () => {
              throw Error('No invalid recording may be probed')
            }
          )
          throw Error('Unexpected success')
        } catch (error) {
          expect(String(error)).not.contains('Unexpected success')
        }
        expect(actual.steps.at(-1)?.outcome).equals('failed')
        if (mode === 'no-ack') expect(calls).not.includes('work')
      }
    )
  it('preserves action failures while stopping the owned recording in finally', async () => {
    const actual = ui([])
    const calls: unknown[] = []
    Object.assign(actual, {
      deviceId: 'owned-simulator',
      fixture: { devices: { ios: { id: 'owned-simulator' } } }
    })
    try {
      await actual.recordTransition(
        join(actual.runDir, 'movie.mp4'),
        async () => {
          throw Error('Action failed')
        },
        recorder(actual, 'valid', calls),
        () => ({ duration: 1 })
      )
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains('Action failed')
    }
    expect(calls).deep.equals(['SIGINT'])
  })
  it('waits for actual complete native header geometry before an info still', async () => {
    let calls = 0
    const actual = ui([])
    actual.present = async () => {}
    actual.device.platformInfo = async () => ({
      screenWidth: 300,
      screenHeight: 600
    })
    actual.nodes = async () => {
      calls++
      return calls === 1
        ? []
        : [
            {
              type: 'Button',
              text: 'Back',
              bounds: { x: 0, y: 0, width: 40, height: 40 }
            },
            {
              type: 'Button',
              text: 'Account, synthetic',
              bounds: { x: 250, y: 0, width: 40, height: 40 }
            }
          ]
    }
    await observeInfoCaptureReady(actual, 1000)
    expect(calls).greaterThan(2)
  })
  it('uses observed OS Copy/Paste to establish and verify the disposable sentinel', async () => {
    const actual = ui([])
    const commands: string[] = []
    let value = ''
    let clipboard = ''
    let menu = ''
    actual.replaceDraft = async text => {
      value = text
    }
    actual.device.longPressOn = async () => {
      commands.push('hold')
      menu = value === '' ? 'Paste' : 'Select All'
    }
    Object.assign(actual.device, {
      hierarchyRaw: async () =>
        raw([
          node(0, 'TextView', {
            identifier: 'chat-composer',
            label: 'Message',
            value
          }),
          ...(menu === '' ? [] : [node(1, 'MenuItem', { label: menu })])
        ])
    })
    actual.device.tapOnPoint = async () => {
      commands.push(menu)
      if (menu === 'Select All') menu = 'Copy'
      else if (menu === 'Copy') {
        clipboard = value
        menu = ''
      } else if (menu === 'Paste') {
        value = clipboard
        menu = ''
      }
    }
    await actual.clipboardSentinel('Disposable sentinel')
    expect(commands).deep.equals([
      'hold',
      'Select All',
      'Copy',
      'hold',
      'Paste'
    ])
    expect(value).equals('')
    expect(clipboard).equals('Disposable sentinel')
  })
  async function zoomedInfoMember(fault = ''): Promise<{
    calls: string[]
    error: unknown
  }> {
    const { actual, page } = browserModel()
    actual.metrics = () => ({
      width: 1440,
      height: 1000,
      dpr: 2,
      coarse: false
    })
    const memberId = userIdOfGumbo(3)
    const row = page.window.document.createElement('button')
    row.dataset.testid = 'chat-info-member-' + memberId
    page.window.document.body.append(row)
    const calls: string[] = []
    let revealed = false
    row.scrollIntoView = options => {
      // A zoomed row wider than the visual viewport keeps an earlier pan
      // under a vertical-only reveal; only its aligned leading edge clears it.
      expect(options).deep.equals({ block: 'center', inline: 'start' })
      calls.push('public-dom-reveal')
      revealed = true
    }
    row.getBoundingClientRect = () =>
      new page.window.DOMRect(
        revealed ? 320 : -32,
        150,
        fault === 'too-wide' ? 1500 : 1000,
        56
      )
    actual.device.scrollUntilVisible = async args => {
      expect(args.element).deep.equals({ id: row.dataset.testid })
      calls.push('driver-full-visibility')
      // The driver's vertical-only wheels cannot reveal an x-clipped row.
      if (row.getBoundingClientRect().x < 0)
        throw Error('Exact member stayed partially outside the viewport')
      return {}
    }
    actual.device.assertVisible = async () => ({})
    actual.observedBounds = async () => {
      const box = row.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    actual.nodes = async () => [
      {
        type: 'Button',
        text: 'Back',
        bounds: { x: 10, y: 20, width: 44, height: 44 }
      }
    ]
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId: userIdOfGumbo(9),
      f: {
        members: [{ userId: memberId, name: 'Cal Ripken', role: 'Member' }]
      },
      observations: []
    }) as Scenarios
    let error: unknown
    try {
      const selected = await scenario.showInfoMember()
      expect(selected.userId).equals(memberId)
      expect(scenario.observations).length(1)
    } catch (failure) {
      error = failure
    }
    return { calls, error }
  }
  it('reveals the exact web member before vertical-only driver scrolling when browser zoom clips it horizontally', async () => {
    const result = await zoomedInfoMember()
    expect(result.error).equals(undefined)
    expect(result.calls).deep.equals([
      'public-dom-reveal',
      'driver-full-visibility'
    ])
  })
  it('still rejects a revealed web member that cannot fit the physical reading viewport', async () => {
    const result = await zoomedInfoMember('too-wide')
    expect(String(result.error)).includes(
      'Finite member row must fit the actual viewport and readable band'
    )
    expect(result.calls).deep.equals([
      'public-dom-reveal',
      'driver-full-visibility'
    ])
  })
  it('chooses an actually unique other-member label for native information framing', async () => {
    const actual = ui([])
    const selectors: unknown[] = []
    actual.device.platformInfo = async () => ({
      screenWidth: 300,
      screenHeight: 600
    })
    actual.device.scrollUntilVisible = async args => {
      selectors.push(args.element)
    }
    actual.device.assertVisible = async () => ({})
    actual.nodes = async () => [
      {
        type: 'Button',
        text: 'Back',
        bounds: { x: 0, y: 0, width: 40, height: 40 }
      },
      {
        type: 'Other',
        text: 'Home',
        bounds: { x: 10, y: 550, width: 280, height: 40 }
      }
    ]
    actual.observedBounds = async (selected, type) => {
      selectors.push([selected, type])
      return { ...box, y: 100 }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId: userIdOfGumbo(9),
      f: {
        members: [
          { userId: userIdOfGumbo(1), name: 'Same', role: '' },
          { userId: userIdOfGumbo(2), name: 'Same', role: '' },
          { userId: userIdOfGumbo(3), name: 'Unique', role: 'Member' }
        ]
      },
      observations: []
    }) as Scenarios
    const selected = await scenario.showInfoMember()
    expect(selected.userId).equals(userIdOfGumbo(3))
    expect(selectors[0]).deep.equals({
      id: 'chat-info-member-' + userIdOfGumbo(3)
    })
    expect(selectors[1]).deep.equals([
      {
        id: 'chat-info-member-' + userIdOfGumbo(3),
        childOf: { id: 'chat-info-members' }
      },
      'Button'
    ])
  })
  it('routes measured iOS movement through explicit drag timing while preserving Android and browser gestures', async () => {
    for (const surface of ['ios', 'android', 'web-wide']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      const signals: Array<AbortSignal | undefined> = []
      const remaining = AbortSignal.timeout(2000)
      actual.device.swipe = async (args, options) => {
        calls.push(['swipe', args])
        signals.push(options?.signal)
      }
      actual.device.dragAndDrop = async (args, options) => {
        calls.push(['drag', args])
        signals.push(options?.signal)
      }
      await actual.measuredSwipe(
        { startX: 10, startY: 20, endX: 40, endY: 50, duration: 350 },
        remaining
      )
      expect(calls).deep.equals(
        surface === 'android'
          ? [
              [
                'swipe',
                { startX: 10, startY: 20, endX: 40, endY: 50, duration: 350 }
              ]
            ]
          : [
              [
                'drag',
                {
                  from: { point: '10,20' },
                  to: { point: '40,50' },
                  holdDuration: surface === 'ios' ? 16 : 1,
                  duration: 350
                }
              ]
            ]
      )
      expect(signals).has.length(1)
      expect(signals[0]).equals(surface === 'web-wide' ? undefined : remaining)
    }
  })
  it('waits for a fresh pending link and actual list after same-provider approval', async () => {
    const actual = ui([], 'web-wide')
    let pendingReads = 0
    let approved = 0
    actual.device.assertVisible = async args => {
      const present =
        args.id === 'chat-conversation-list' ? approved > 0 : approved === 0
      if (!present)
        throw Object.assign(Error('Not yet visible'), {
          code: 'COMMAND_FAILED'
        })
      return {}
    }
    const provider = {
      client: {
        chatLinks: async () =>
          ++pendingReads === 1 || approved > 0 ? [] : [{}]
      },
      approvePending: async () => {
        approved++
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      observations: []
    }) as Scenarios
    await scenario.approveBrowserLink(
      provider as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>,
      AbortSignal.timeout(2000)
    )
    expect(approved).equals(1)
    const samples = scenario.observations[0].browserLinkApproval as Array<
      Record<string, unknown>
    >
    expect(samples.map(s => s.pendingCount)).deep.equals([0, 1, undefined])
    expect(samples[1].approvalCompletedAt).a('string')
    expect(samples[1].pendingAfter).equals(0)
    expect(samples.at(-1)?.list).equals(true)
  })
  for (const mode of ['empty', 'rejected', 'transport', 'ambiguous', 'no-list'])
    it('does not accept unresolved browser linking: ' + mode, async () => {
      const actual = ui([], 'web-wide')
      let approved = 0
      actual.device.assertVisible = async args => {
        if (mode === 'transport') throw Error('Read transport failed')
        if (args.id != null && mode !== 'ambiguous')
          throw Object.assign(Error('No list'), { code: 'COMMAND_FAILED' })
        return {}
      }
      const provider = {
        client: { chatLinks: async () => (mode === 'empty' ? [] : [{}]) },
        approvePending: async () => {
          approved++
          if (mode === 'rejected') throw Error('Approval rejected')
        }
      }
      const scenario = Object.assign(Object.create(Scenarios.prototype), {
        ui: actual,
        observations: []
      }) as Scenarios
      await captureFailure(
        scenario.approveBrowserLink(
          provider as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>,
          AbortSignal.timeout(50)
        )
      )
      expect(scenario.observations[0].outcome).equals('failed')
      if (mode === 'empty' || mode === 'transport' || mode === 'ambiguous')
        expect(approved).equals(0)
    })
  it('aborts an in-flight existing-provider API read with the supplied approval deadline', async () => {
    const path = mkdtempSync(join(tmpdir(), 'chat-link-deadline-'))
    directories.push(path)
    const sessionFile = join(path, 'session.json')
    writeFileSync(sessionFile, JSON.stringify({ token: 'TEST_TOKEN' }))
    const fixture = {
      apiUrl: 'https://fixture.example.test/api/v1',
      actors: {
        viewer: { userId: userIdOfGumbo(1), provider: { sessionFile } }
      }
    }
    const original = globalThis.fetch
    let observed: AbortSignal | null | undefined
    globalThis.fetch = async (_input, init) => {
      observed = init?.signal
      if (observed == null) throw Error('Missing real API abort signal')
      const signal = observed
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true }
        )
      })
    }
    const signal = AbortSignal.timeout(20)
    try {
      await captureFailure(
        fixtureClient(fixture as unknown as Chat2Fixture, 'viewer', signal)
      )
      expect(observed).equals(signal)
      expect(signal.aborted).equals(true)
    } finally {
      globalThis.fetch = original
    }
  })
  function keyboardMenu(mode = 'valid'): {
    scenario: Scenarios
    calls: string[]
    actual: Chat2UI
    page: JSDOM
  } {
    const { actual, page } = browserModel()
    actual.metrics = () => ({ width: 300, height: 600, dpr: 1, coarse: false })
    page.window.document.body.innerHTML =
      '<button id="pins">Pins</button><div data-testid="chat-message-history"><div data-testid="chat-message-target"><div data-testid="chat-bubble-target">Synthetic body</div><button role="button" aria-label="More message actions">More</button></div></div><textarea data-testid="chat-composer">Unsent draft</textarea>'
    const editor = page.window.document.querySelector('textarea')!
    const trigger = page.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="More message actions"]'
    )!
    trigger.getBoundingClientRect = () =>
      new page.window.DOMRect(20, 100, 48, 48)
    const calls: string[] = []
    let panel: HTMLElement | undefined
    actual.id = async id => {
      expect(id).equals('chat-composer')
      calls.push('focus')
      editor.focus()
    }
    actual.device.assertVisible = async args => {
      if (args.focused === true) {
        calls.push('focused-proof')
        if (page.window.document.activeElement !== editor)
          throw Error('Composer not focused')
      }
      return {}
    }
    actual.device.tapOn = async args => {
      expect(String(args.css)).contains('More message actions')
      calls.push('open-more')
      trigger.focus()
      panel = page.window.document.createElement('div')
      panel.setAttribute('aria-label', 'Message from Synthetic member')
      const control = page.window.document.createElement('button')
      control.textContent = 'Copy text'
      panel.append(control)
      page.window.document.body.append(panel)
      control.focus()
    }
    actual.device.scrollUntilVisible = async () => {}
    actual.device.pressKey = async args => {
      expect(args.key).equals('ESC')
      calls.push('dismiss')
      if (mode !== 'retained-menu') panel?.remove()
      if (mode === 'wrong-focus') editor.focus()
      else if (mode === 'deferred-focus')
        page.window.setTimeout(() => {
          trigger.focus()
        }, 15)
      else if (mode === 'missing-trigger') trigger.remove()
      else if (mode !== 'permanent-body') trigger.focus()
      if (mode === 'changed-draft') editor.value = 'Changed'
    }
    actual.shot = async () => {}
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: { id: 'target' } } },
      observations: []
    }) as Scenarios
    scenario.check = async (name, work) => {
      if (name.startsWith('E5 keyboard-open')) await work()
    }
    scenario.openGroup = async () => {}
    scenario.anchor = async () => {
      calls.push('anchor')
      if (calls.filter(c => c === 'anchor').length > 1)
        throw Error('Pinned navigation repeated after focus certificate')
      page.window.document.querySelector<HTMLButtonElement>('#pins')!.focus()
    }
    scenario.targetBounds = async () => box
    scenario.menuState = async () => ({})
    return { scenario, calls, actual, page }
  }
  it('prepares the E5 reader before focus and verifies the actual desktop More trigger after Escape', async () => {
    const { scenario, calls } = keyboardMenu()
    await scenario.E5()
    expect(calls).deep.equals([
      'anchor',
      'focus',
      'focused-proof',
      'open-more',
      'dismiss'
    ])
    const proof = scenario.observations[0].messageActionFocus as Array<
      Record<string, unknown>
    >
    expect(proof[0].composerFocused).equals(true)
    expect(proof[1].triggerFocused).equals(true)
    expect(proof[1].menus).equals(0)
  })
  it('waits for deferred real More focus after closed-menu BODY observation', async () => {
    const { scenario } = keyboardMenu('deferred-focus')
    await scenario.E5()
    const samples = (
      scenario.observations[0].messageActionFocus as Array<
        Record<string, unknown>
      >
    ).filter(sample => sample.phase === 'after-dismissal')
    expect(samples.length).greaterThan(1)
    expect(samples[0].triggerFocused).equals(false)
    expect((samples[0].active as Record<string, unknown>).tag).equals('BODY')
    expect(samples.at(-1)?.triggerFocused).equals(true)
    expect(samples.at(-1)?.menus).equals(0)
    expect(samples.at(-1)?.spotlights).equals(0)
  })
  for (const mode of ['permanent-body', 'missing-trigger'])
    it('rejects unavailable desktop restoration: ' + mode, async () => {
      const { scenario, actual } = keyboardMenu(mode)
      Object.assign(actual, { deadline: AbortSignal.timeout(40) })
      await captureFailure(scenario.E5())
      const samples = (
        scenario.observations[0].messageActionFocus as Array<
          Record<string, unknown>
        >
      ).filter(sample => sample.phase === 'after-dismissal')
      if (mode === 'permanent-body') {
        expect(samples.length).greaterThan(0)
        expect(samples.every(sample => sample.triggerFocused === false)).equals(
          true
        )
        expect((samples[0].active as Record<string, unknown>).tag).equals(
          'BODY'
        )
      } else expect(samples).deep.equals([])
    })
  for (const mode of ['wrong-focus', 'retained-menu', 'changed-draft'])
    it(
      'retains strict desktop dismissal and draft evidence: ' + mode,
      async () => {
        const { scenario } = keyboardMenu(mode)
        await captureFailure(scenario.E5())
      }
    )
  async function touchKeyboardMenu(mode = ''): Promise<{
    scenario: Scenarios
    calls: string[]
    error: unknown
  }> {
    const { scenario, actual, calls, page } = keyboardMenu()
    Object.assign(actual, { surface: 'web-touch' })
    actual.metrics = () => ({ width: 300, height: 600, dpr: 1, coarse: true })
    const editor = page.window.document.querySelector('textarea')!
    const bubble = page.window.document.querySelector<HTMLElement>(
      '[data-testid="chat-bubble-target"]'
    )!
    const more = page.window.document.querySelector<HTMLElement>(
      '[aria-label="More message actions"]'
    )!
    bubble.tabIndex = 0
    bubble.getBoundingClientRect = () =>
      new page.window.DOMRect(48, 114, 200, 60)
    let overlay: HTMLElement | undefined
    let readyReads = 0
    actual.shot = async () => {
      const parts = Array.from(overlay!.children).slice(0, 3)
      expect(
        parts.map(part => page.window.getComputedStyle(part).opacity),
        'E5 static shot requires fully opaque actual spotlight parts'
      ).deep.equals(['1', '1', '1'])
      expect(actual.steps.at(-1)).includes({
        name: 'Settled spotlight capture readiness',
        outcome: 'passed'
      })
      expect(readyReads).at.least(3)
      calls.push('settled-shot')
    }
    actual.device.longPressOn = async args => {
      expect(args).deep.equals({ id: 'chat-bubble-target', duration: 550 })
      expect(
        page.window.document.activeElement,
        'Composer must own the prehold focus'
      ).equals(editor)
      calls.push('hold')
      bubble.focus()
      overlay = page.window.document.createElement('div')
      overlay.dataset.testid = 'chat-message-spotlight'
      overlay.setAttribute('aria-label', 'Message from Synthetic member')
      for (const name of ['backdrop', 'controls', 'panel']) {
        const part = page.window.document.createElement('div')
        part.dataset.testid = 'chat-message-spotlight-' + name
        part.style.cssText =
          'opacity:0.4;transform:none;display:block;visibility:visible'
        part.getBoundingClientRect = () => {
          if (name === 'backdrop') readyReads++
          if (readyReads >= 3 && mode !== 'not-opaque') part.style.opacity = '1'
          return new page.window.DOMRect(0, 0, 200, 100)
        }
        overlay.append(part)
      }
      const action = page.window.document.createElement('button')
      overlay.append(action)
      if (mode === 'closing-clone') {
        const source = bubble.closest('[data-testid="chat-message-target"]')!
        overlay.append(source.cloneNode(true))
      }
      if (mode === 'duplicate-history-row')
        bubble.parentElement!.parentElement!.append(
          bubble.parentElement!.cloneNode(true)
        )
      page.window.document.body.append(overlay)
      action.focus()
    }
    actual.device.pressKey = async args => {
      expect(args.key).equals('ESC')
      calls.push('dismiss')
      if (mode === 'closing-clone') {
        page.window.setTimeout(() => {
          overlay?.remove()
          bubble.focus()
        }, 20)
        return
      }
      if (mode !== 'retained-overlay') overlay?.remove()
      if (mode === 'wrong-owner') more.focus()
      else if (mode === 'composer-owner') editor.focus()
      else bubble.focus()
      if (mode === 'changed-draft') editor.value = 'Changed'
      if (mode !== '')
        Object.assign(actual, { deadline: AbortSignal.timeout(80) })
    }
    let error: unknown
    try {
      await scenario.E5()
    } catch (failure) {
      error = failure
    }
    return { scenario, calls, error }
  }
  it('restores the exact touch bubble trigger after Escape without claiming a software keyboard on web', async () => {
    const result = await touchKeyboardMenu()
    expect(result.error).equals(undefined)
    expect(result.calls).deep.equals([
      'anchor',
      'focus',
      'focused-proof',
      'hold',
      'settled-shot',
      'dismiss'
    ])
    const samples = result.scenario.observations[0].messageActionFocus as Array<
      Record<string, unknown>
    >
    expect(samples[0].composerFocused).equals(true)
    expect(samples[0].triggerFocused).equals(false)
    const after = samples.at(-1)!
    expect(after.triggerFocused).equals(true)
    expect((after.active as Record<string, unknown>).id).equals(
      'chat-bubble-target'
    )
    expect(after.trigger).deep.equals({ x: 48, y: 114, width: 200, height: 60 })
    expect(after.menus).equals(0)
    expect(after.spotlights).equals(0)
  })
  it('refuses the E5 static shot while its actual spotlight remains translucent', async () => {
    const result = await touchKeyboardMenu('not-opaque')
    expect(String(result.error)).includes(
      'Timed out waiting for settled spotlight presentation'
    )
    expect(result.calls).not.includes('settled-shot')
    expect(result.calls).not.includes('dismiss')
  })
  it('waits for the duplicate spotlight preview to unmount while tracking the unique original history trigger', async () => {
    const result = await touchKeyboardMenu('closing-clone')
    expect(result.error).equals(undefined)
    const samples = result.scenario.observations[0].messageActionFocus as Array<
      Record<string, unknown>
    >
    const after = samples.filter(sample => sample.phase === 'after-dismissal')
    expect(after.length).greaterThan(1)
    expect(after[0].spotlights).equals(1)
    expect(after.at(-1)).includes({
      triggerFocused: true,
      menus: 0,
      spotlights: 0
    })
  })
  it('rejects duplicate actual history rows rather than choosing the first matching trigger', async () => {
    const result = await touchKeyboardMenu('duplicate-history-row')
    expect(String(result.error)).includes(
      'Unique message row required for action focus'
    )
  })
  for (const mode of [
    'wrong-owner',
    'composer-owner',
    'retained-overlay',
    'changed-draft'
  ])
    it(
      'rejects an unproved touch bubble focus return or altered draft: ' + mode,
      async () => {
        const result = await touchKeyboardMenu(mode)
        expect(result.error).not.equals(undefined)
        expect(result.calls).includes('dismiss')
        const samples = result.scenario.observations[0]
          .messageActionFocus as Array<Record<string, unknown>>
        if (mode === 'wrong-owner' || mode === 'composer-owner')
          expect(
            samples
              .filter(sample => sample.phase === 'after-dismissal')
              .every(sample => sample.triggerFocused === false)
          ).equals(true)
        if (mode === 'retained-overlay')
          expect(samples.at(-1)?.spotlights).equals(1)
        if (mode === 'changed-draft')
          expect(String(result.error)).includes(
            'Message actions must preserve the actual draft'
          )
      }
    )
  it('keeps two positive native keyboard proofs and never infers an empty native draft', async () => {
    const actual = ui([])
    let focus = 0
    let anchored = 0
    actual.id = async () => {}
    actual.assertKeyboard = async () => {
      focus++
    }
    actual.draft = async () => {
      throw Error('No empty native value assumption')
    }
    actual.present = async () => {}
    actual.device.longPressOn = async () => {}
    actual.device.assertVisible = async () => ({})
    actual.device.tapOn = async args => {
      expect(args.text).equals('^Cancel$')
    }
    actual.device.scrollUntilVisible = async () => {}
    actual.back = async () => {}
    actual.shot = async () => {}
    actual.hideKeyboard = async () => {}
    actual.publicBounds = async () => box
    actual.device.screenshot = async () => captureImages[0]
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: { id: 'target' } } },
      observations: []
    }) as Scenarios
    scenario.check = async (name, work) => {
      if (name.startsWith('E5 keyboard-open')) await work()
    }
    scenario.openGroup = async () => {}
    scenario.anchor = async () => {
      anchored++
    }
    scenario.targetBounds = async () => box
    scenario.menuState = async () => ({})
    await scenario.E5()
    expect(focus).equals(2)
    expect(anchored).equals(1)
  })
  it('binds a clipped long hold to the actual bubble with an element-relative visible point', async () => {
    const actual = ui([])
    const calls: unknown[] = []
    actual.hideKeyboard = async () => {}
    actual.absent = async () => {}
    actual.present = async () => {}
    actual.device.screenshot = async () => captureImages[0]
    actual.shot = async () => {}
    actual.publicBounds = async () => ({
      x: 0,
      y: 100,
      width: 250,
      height: 100
    })
    actual.device.platformInfo = async () => ({
      screenWidth: 300,
      screenHeight: 600
    })
    actual.device.longPressOn = async args => {
      calls.push(args)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { long: { id: 'long' } } },
      observations: []
    }) as Scenarios
    scenario.check = async (name, work) => {
      if (name.startsWith('E5 partially scrolled')) await work()
    }
    scenario.openGroup = async () => {}
    scenario.anchor = async () => {}
    scenario.readingBand = async () => ({ top: 100, bottom: 500 })
    scenario.targetBounds = async () => ({
      x: 10,
      y: -200,
      width: 200,
      height: 1000
    })
    scenario.menuState = async () => ({})
    scenario.dismiss = async () => {}
    await scenario.E5()
    expect(calls).deep.equals([
      { id: 'chat-bubble-long', point: '50%,50%', duration: 550 }
    ])
  })
  it('measures a clipped web touch preview only after its entrance fade has settled', async () => {
    const actual = ui([], 'web-touch')
    const order: string[] = []
    let settled = false
    const box = { x: 8, y: 64, width: 273, height: 544 }
    const opaque = {
      opacity: 1,
      transform: 'none',
      display: 'flex',
      visibility: 'visible'
    }
    Object.assign(actual, {
      native: false,
      metrics: () => ({ width: 390, height: 844, coarse: true })
    })
    actual.present = async () => {}
    actual.absent = async () => {}
    actual.shot = async () => {
      order.push('shot')
    }
    actual.device.longPressOn = async () => {
      order.push('hold')
    }
    actual.dom = async script => {
      if (script.includes('publicReaderScroll'))
        return { publicReaderScroll: true }
      order.push('readiness')
      settled = true
      return {
        geometry: { controls: box, panel: box, backdrop: box, preview: box },
        styles: {
          controls: opaque,
          panel: opaque,
          backdrop: opaque,
          preview: opaque
        }
      }
    }
    actual.publicBounds = async id => {
      // Public DOM nodes omit the preview while its fade is still at opacity 0.
      if (id === 'chat-message-spotlight-preview') {
        if (!settled) throw Error('Measured public DOM element bounds required')
        order.push('preview')
      }
      return box
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { long: { id: 'long' } } },
      observations: []
    }) as Scenarios
    scenario.check = async (name, work) => {
      if (name.startsWith('E5 partially scrolled')) await work()
    }
    scenario.openGroup = async () => {}
    scenario.anchor = async () => {}
    scenario.readingBand = async () => ({ top: 106, bottom: 679 })
    scenario.targetBounds = async () => ({
      x: 48,
      y: -14,
      width: 273,
      height: 648
    })
    scenario.menuState = async () => ({})
    scenario.dismiss = async () => {}
    await scenario.E5()
    expect(order.indexOf('hold')).lessThan(order.indexOf('readiness'))
    expect(order.indexOf('readiness')).lessThan(order.indexOf('preview'))
    expect(order.at(-1)).equals('shot')
    expect(scenario.observations.at(-1)).deep.includes({
      selectedPreview: box
    })
  })
  for (const zoom of [
    {
      name: 'a panned pinch-zoomed',
      viewport: { scale: 1.5, left: 48, top: 141, right: 308, bottom: 704 },
      point: '47.6%,65%'
    },
    {
      name: 'an unzoomed',
      viewport: { scale: 1, left: 0, top: 0, right: 390, bottom: 844 },
      point: undefined
    }
  ])
    it(
      'holds ' +
        zoom.name +
        ' web touch bubble at a visible point in the driver coordinate space',
      async () => {
        const actual = ui([], 'web-touch')
        const holds: unknown[] = []
        Object.assign(actual, {
          native: false,
          metrics: () => ({ width: 390, height: 844, coarse: true })
        })
        actual.dom = async script => {
          expect(script).includes('visualViewport')
          return {
            ...zoom.viewport,
            x: 48,
            y: 114,
            width: 273,
            height: 90
          }
        }
        actual.device.longPressOn = async args => {
          holds.push(args)
        }
        actual.device.assertVisible = async () => ({})
        const scenario = Object.assign(Object.create(Scenarios.prototype), {
          ui: actual,
          observations: []
        }) as Scenarios
        scenario.anchor = async () => {}
        scenario.readingBand = async () => ({ top: 106, bottom: 679 })
        const target: Chat2Message = {
          id: 'target',
          seq: 1,
          body: 'Bring water.',
          authorId: userIdOfGumbo(1)
        }
        await scenario.action(target)
        expect(holds).deep.equals([
          {
            id: 'chat-bubble-target',
            ...(zoom.point == null ? {} : { point: zoom.point }),
            duration: 550
          }
        ])
      }
    )
  it('ignores a full-screen Back wrapper when the real member row is already exposed', async () => {
    const actual = ui([])
    const gestures: unknown[] = []
    actual.device.platformInfo = async () => ({
      screenWidth: 320,
      screenHeight: 720
    })
    actual.device.scrollUntilVisible = async () => {}
    actual.device.assertVisible = async () => ({})
    actual.device.swipe = async args => {
      gestures.push(args)
    }
    actual.nodes = async () => [
      {
        type: 'Other',
        text: 'Back',
        bounds: { x: 0, y: 0, width: 320, height: 720 }
      },
      {
        type: 'Button',
        text: 'Back',
        bounds: { x: 10, y: 30, width: 44, height: 44 }
      },
      {
        type: 'Button',
        text: 'Account, synthetic',
        bounds: { x: 266, y: 30, width: 44, height: 44 }
      },
      {
        type: 'Other',
        text: 'Home',
        bounds: { x: 20, y: 640, width: 280, height: 60 }
      }
    ]
    actual.observedBounds = async () => ({
      x: 20,
      y: 400,
      width: 280,
      height: 56
    })
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId: userIdOfGumbo(9),
      f: {
        members: [{ userId: userIdOfGumbo(3), name: 'Unique', role: 'Member' }]
      },
      observations: []
    }) as Scenarios
    const selected = await scenario.showInfoMember()
    expect(selected.userId).equals(userIdOfGumbo(3))
    expect(gestures).deep.equals([])
    expect(scenario.observations[0]).deep.includes({
      infoMemberFraming: {
        userId: userIdOfGumbo(3),
        selector: { id: 'chat-info-member-' + userIdOfGumbo(3) },
        bounds: { x: 20, y: 400, width: 280, height: 56 },
        unobscuredBand: { top: 82, bottom: 632 },
        expectedRole: 'Member'
      }
    })
  })
  it('rejects out-of-viewport measured gestures before any native or browser dispatch', async () => {
    for (const surface of ['ios', 'android', 'web-wide']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.device.swipe = async args => {
        calls.push(args)
      }
      actual.device.dragAndDrop = async args => {
        calls.push(args)
      }
      for (const invalid of [
        { startY: 700 },
        { endY: 600 },
        { startX: 300 },
        { endX: 0 },
        { endY: Infinity }
      ]) {
        try {
          await actual.measuredSwipe({
            startX: 10,
            startY: 20,
            endX: 40,
            endY: 50,
            duration: 200,
            ...invalid
          })
          throw Error('Unexpected success')
        } catch (error) {
          expect(String(error)).not.contains('Unexpected success')
        }
      }
      expect(calls).deep.equals([])
    }
  })
  it('rejects an unusably short member band before issuing a swipe', async () => {
    const actual = ui([])
    const gestures: unknown[] = []
    actual.device.platformInfo = async () => ({
      screenWidth: 320,
      screenHeight: 160
    })
    actual.device.scrollUntilVisible = async () => {}
    actual.device.swipe = async args => {
      gestures.push(args)
    }
    actual.nodes = async () => [
      {
        type: 'Button',
        text: 'Back',
        bounds: { x: 10, y: 10, width: 40, height: 40 }
      },
      {
        type: 'Other',
        text: 'Home',
        bounds: { x: 20, y: 81, width: 280, height: 40 }
      }
    ]
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId: userIdOfGumbo(9),
      f: {
        members: [{ userId: userIdOfGumbo(3), name: 'Unique', role: 'Member' }]
      },
      observations: []
    }) as Scenarios
    try {
      await scenario.showInfoMember()
      throw Error('Unexpected success')
    } catch (error) {
      expect(String(error)).contains(
        'Meaningful in-viewport member reading band'
      )
    }
    expect(gestures).deep.equals([])
  })
})

describe('positive Android IME observations', function () {
  this.timeout(10000)
  const viewport = { width: 400, height: 800 }
  const shown =
    'Window #0 Window{0000 u0 InputMethod}:\n isOnScreen=true\n touchable region=SkRegion((0,560,400,800))\n'
  const paths: string[] = []
  const processApi = createRequire(resolve('package.json'))(
    'node:child_process'
  )
  const originalSpawn = processApi.spawnSync
  const originalAdb = process.env.CHAT2_ADB
  afterEach(() => {
    processApi.spawnSync = originalSpawn
    if (originalAdb == null) delete process.env.CHAT2_ADB
    else process.env.CHAT2_ADB = originalAdb
    for (const path of paths.splice(0))
      rmSync(path, { recursive: true, force: true })
  })
  const hiddenCaptureIme =
    'Window #0 Window{0000 u0 InputMethod}:\n mHasSurface=false\n isOnScreen=false\n isVisible=false\n mGlobalConfiguration={synthetic}'
  const openCaptureIme =
    'Window #0 Window{0000 u0 InputMethod}:\n mHasSurface=true\n Surface: shown=true\n isOnScreen=true\n isVisible=true\n touchable region=SkRegion((0,560,400,800))\n mGlobalConfiguration={synthetic}'
  interface NativeNode {
    type: string
    id?: string
    text?: string
    bounds?: CaptureBox
    focused?: boolean
    enabled?: boolean
    selected?: boolean
    children?: NativeNode[]
  }
  function captureTree(open = false): NativeNode {
    const y = open ? 450 : 650
    return {
      type: 'ViewGroup',
      children: [
        {
          id: 'chat-message-history',
          type: 'ScrollView',
          bounds: { x: 0, y: 0, width: 400, height: 800 }
        },
        {
          id: 'chat-composer-band',
          type: 'ViewGroup',
          bounds: { x: 20, y: y - 50, width: 360, height: 100 },
          children: [
            {
              id: 'chat-composer',
              type: 'EditText',
              text: 'Preserved synthetic text',
              focused: true,
              bounds: { x: 100, y, width: 220, height: 40 }
            },
            {
              type: 'Button',
              text: 'Attach',
              bounds: { x: 24, y, width: 44, height: 44 }
            },
            {
              type: 'Button',
              text: 'Send',
              enabled: false,
              bounds: { x: 332, y, width: 44, height: 44 }
            }
          ]
        },
        {
          type: 'View',
          children: ['Home', 'Videos', 'Schedule', 'Search', 'Chat'].map(
            (text, index) => ({
              type: 'View',
              text,
              selected: text === 'Chat',
              bounds: { x: 10 + index * 75, y: 730, width: 65, height: 50 }
            })
          )
        }
      ]
    }
  }
  it('measures typed picker controls in the scene while retaining the leaf header marker', async () => {
    const scene: NativeNode = {
      id: 'chat-picker-scene',
      type: 'ViewGroup',
      bounds: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        {
          id: 'chat-picker-header',
          type: 'View',
          bounds: { x: 0, y: 0, width: 400, height: 110 }
        },
        {
          type: 'ViewGroup',
          children: [
            {
              type: 'TextView',
              text: 'Mention a member',
              bounds: { x: 16, y: 64, width: 170, height: 24 }
            },
            {
              type: 'Button',
              text: 'Cancel',
              bounds: { x: 290, y: 50, width: 96, height: 48 }
            }
          ]
        },
        {
          id: 'chat-picker-content',
          type: 'ScrollView',
          bounds: { x: 0, y: 110, width: 400, height: 690 },
          children: [
            {
              type: 'EditText',
              text: 'Search members',
              bounds: { x: 16, y: 150, width: 368, height: 48 }
            }
          ]
        }
      ]
    }
    expect(androidMentionHeaderGeometry(scene).cancel.width).equals(96)
    const actual = model().ui
    actual.device.hierarchy = async () => scene
    actual.device.assertVisible = async () => {
      throw Error('No hybrid picker lookup')
    }
    await observeMentionHeader(actual)
    expect(
      actual.steps.find(
        step => step.name === 'Settled mention chooser header geometry'
      )?.outcome
    ).equals('passed')
    const cancel = scene.children![1].children![1]
    cancel.bounds!.y = 120
    expect(() => androidMentionHeaderGeometry(scene)).throws('measured marker')
    cancel.bounds!.y = 50
    scene.children![1].children!.push({ ...cancel })
    expect(() => androidMentionHeaderGeometry(scene)).throws('Unique scoped')
  })
  it('requires explicit current closed OS state and preserves open-to-closed movement separately', () => {
    const closed = androidCaptureImeState(hiddenCaptureIme, viewport)
    expect(closed.state).equals('already-closed')
    const before = androidDismissReference(captureTree(), closed, viewport)
    expect(Object.isFrozen(before)).equals(true)
    expect(before.keyboard).equals(undefined)
    expect(
      androidClosedCaptureGeometry(captureTree(), before).navigation
    ).length(5)
    const open = androidDismissReference(
      captureTree(true),
      androidCaptureImeState(openCaptureIme, viewport),
      viewport
    )
    expect(() => androidClosedCaptureGeometry(captureTree(true), open)).throws(
      'former IME region'
    )
    expect(androidClosedCaptureGeometry(captureTree(), open).text).equals(
      before.text
    )
    for (const raw of [
      'No InputMethod window',
      hiddenCaptureIme.replace('isOnScreen=false', 'isOnScreen=unknown'),
      hiddenCaptureIme.replace(
        'isOnScreen=false',
        'isOnScreen=false\n isOnScreen=false'
      )
    ])
      expect(() => androidCaptureImeState(raw, viewport)).throws()
    const noNavigation = captureTree()
    noNavigation.children!.pop()
    expect(() => androidClosedCaptureGeometry(noNavigation, before)).throws(
      'navigation'
    )
  })
  it('retains a fresh typed disabled Send without using the hybrid finder or inventing metadata', async () => {
    const actual = model().ui
    const tree = captureTree(true)
    actual.device.hierarchy = async () => tree
    actual.device.assertVisible = async () => {
      throw Error('Hybrid control lookup must not run')
    }
    expect(
      await actual.androidComposerControl('Send', new AbortController().signal)
    ).deep.equals(tree.children![1].children![2].bounds)
    const observed = androidComposerControl(tree, 'Send', viewport)
    expect(observed).equals(tree.children![1].children![2])
    expect(observed.enabled).equals(false)
    for (const key of ['id', 'class', 'focused'])
      expect(Object.hasOwn(observed, key)).equals(false)
    const saved = actual.steps.find(
      step => step.name === 'Fresh Android capture hierarchy'
    )!
    expect(JSON.parse(readFileSync(String(saved.path), 'utf8'))).deep.equals(
      tree
    )
    const button = tree.children![1].children!.pop()!
    tree.children!.push(button)
    expect(() => androidComposerControl(tree, 'Send', viewport)).throws(
      'descend'
    )
    tree.children!.pop()
    button.bounds!.width = 0
    tree.children![1].children!.push(button)
    expect(() => androidComposerControl(tree, 'Send', viewport)).throws(
      'Positive actual Button'
    )
  })
  it('refuses an aborted control read or a closed capture without its actual per-hide witness', async () => {
    const actual = model().ui
    const controller = new AbortController()
    controller.abort()
    actual.device.hierarchy = async () => {
      throw Error('Unexpected native read')
    }
    expect(
      String(
        await captureFailure(
          actual.androidComposerControl('Send', controller.signal)
        )
      )
    ).not.contains('Unexpected native read')
    Object.assign(actual, { scenario: 'capture' })
    expect(
      String(
        await captureFailure(
          actual.shot('conversation', 'Missing witness model')
        )
      )
    ).contains('dismissal witness required')
  })
  for (const mode of [
    'already-closed',
    'already-open',
    'pending-open',
    'unknown',
    'unstable'
  ])
    it(
      'settles ' +
        mode +
        ' before one ordinary capture hide and revalidates the closed shot',
      async () => {
        const actual = model().ui
        let open = mode === 'already-open'
        let reads = 0
        let shots = 0
        let hides = 0
        let focused = 0
        const order: string[] = []
        processApi.spawnSync = (_command: string, args: string[]) => {
          if (args.includes('InputMethod')) {
            reads++
            if (mode === 'pending-open' && reads === 3) open = true
            order.push(open ? 'open' : 'closed')
            return {
              status: 0,
              signal: null,
              stdout:
                mode === 'unknown' && reads === 2
                  ? hiddenCaptureIme.replace('false', 'unknown')
                  : open
                    ? openCaptureIme
                    : hiddenCaptureIme,
              stderr: ''
            }
          }
          expect(args[0]).equals('-c')
          return {
            status: 0,
            signal: null,
            stdout: '{"width":1,"height":1,"mode":"RGBA"}',
            stderr: ''
          }
        }
        Object.assign(actual, {
          scenario: 'capture',
          captures: [],
          deadline: AbortSignal.timeout(mode === 'unstable' ? 600 : 10000)
        })
        actual.device.hierarchy = async () => captureTree(open)
        actual.device.screenshot = async () =>
          captureImages[mode === 'unstable' ? ++shots % 2 : 0]
        actual.device.assertVisible = async args => {
          expect(args).includes({
            id: 'chat-composer',
            focused: true,
            enabled: true
          })
          expect(open).equals(true)
          focused++
          order.push('focus')
        }
        actual.device.hideKeyboard = async (value, options) => {
          expect(value).equals(undefined)
          expect(options?.signal.aborted).equals(false)
          hides++
          order.push('hide')
          open = false
        }
        actual.captureImage = async () => {
          order.push('final-image')
          return {}
        }
        if (mode === 'unknown' || mode === 'unstable') {
          await captureFailure(actual.hideKeyboardForCapture())
          expect(hides).equals(0)
        } else {
          await actual.hideKeyboardForCapture()
          expect(hides).equals(1)
          expect(focused).equals(mode === 'already-closed' ? 0 : 1)
          if (focused > 0)
            expect(order.indexOf('focus')).lessThan(order.indexOf('hide'))
          await actual.shot(
            'conversation',
            'Actual closed state revalidation model'
          )
          expect(order.at(-1)).equals('final-image')
          expect(hides).equals(1)
          const proof = actual.steps.find(
            step => step.name === 'Passive Android initial capture state'
          )!
          expect(proof.outcome).equals('passed')
          if (mode === 'already-closed')
            expect(Number(proof.exactPairMs)).at.least(200)
          else expect(proof.initialDispatch).equals('open')
        }
      }
    )
  function model(mode = 'valid'): {
    ui: Chat2UI
    calls: unknown[]
    raw: string
    probes: () => number
    focusChecks: () => number
  } {
    const calls: unknown[] = []
    const runDir = mkdtempSync(join(tmpdir(), 'android-ime-'))
    paths.push(runDir)
    // A missed stub must fail locally rather than reach an installed adb.
    process.env.CHAT2_ADB = join(runDir, 'unavailable-observer-fixture')
    let probes = 0
    let focusChecks = 0
    const tree = (): { type: string; children: unknown[] } => {
      probes += 1
      const band = {
        x: 20,
        y: mode === 'overlap' ? 500 : 400,
        width: 360,
        height: 100
      }
      const editor: PublicNode = {
        id: 'chat-composer',
        type: 'EditText',
        focused: mode !== 'unfocused',
        bounds: {
          x: 100,
          y: mode === 'overlap' ? 550 : 450,
          width: 220,
          height: 40
        }
      }
      if (mode === 'disabled') editor.enabled = false
      if (mode === 'outside-editor') editor.bounds!.x = 0
      if (mode === 'zero-editor') editor.bounds!.height = 0
      const nodes: PublicNode[] = [
        { id: 'chat-composer-band', type: 'ViewGroup', bounds: band },
        editor,
        {
          type: 'Button',
          text: 'Attach',
          bounds: { x: 24, y: 450, width: 44, height: 44 }
        },
        {
          type: 'Button',
          text: 'Send',
          enabled: false,
          bounds: { x: 332, y: 450, width: 44, height: 44 }
        },
        {
          type: 'Button',
          text: 'Cancel reply',
          bounds: { x: 344, y: 410, width: 24, height: 24 }
        }
      ]
      if (mode === 'duplicate-editor') nodes.push({ ...editor })
      if (mode === 'missing-band') nodes.shift()
      if (mode === 'missing-editor') nodes.splice(1, 1)
      if (mode === 'duplicate-send') nodes.push({ ...nodes[3] })
      if (mode === 'outside-send') nodes[3].bounds!.x = 390
      for (const [name, index] of [
        ['attach', 2],
        ['send', 3],
        ['cancel', 4]
      ] as const) {
        if (mode === 'zero-' + name) nodes[index].bounds!.width = 0
        if (mode === 'negative-' + name) nodes[index].bounds!.height = -1
        if (mode === 'nonfinite-' + name) nodes[index].bounds!.x = NaN
      }
      if (mode === 'overlay' && probes > 1)
        nodes.push({ id: 'chat-picker-scene', bounds: band })
      if (mode === 'geometry-change' && focusChecks % 2 === 0) {
        nodes[0].bounds = { ...band, y: band.y - 5 }
        editor.bounds = { ...editor.bounds!, y: editor.bounds!.y - 5 }
      }
      const container = nodes.find(node => node.id === 'chat-composer-band')
      const overlays = nodes.filter(node => node.id === 'chat-picker-scene')
      const children = nodes.filter(
        node => node !== container && !overlays.includes(node)
      )
      return {
        type: 'ViewGroup',
        children: [
          {
            id: 'chat-message-history',
            type: 'ScrollView',
            bounds: { x: 0, y: 0, ...viewport }
          },
          ...(container == null ? children : [{ ...container, children }]),
          ...overlays
        ]
      }
    }
    const actualRaw = mode === 'hidden' ? shown.replace('true', 'false') : shown
    processApi.spawnSync = (
      command: string,
      argv: string[],
      options: Record<string, unknown>
    ) => {
      calls.push({ command, argv, options })
      if (mode === 'transport')
        return {
          status: 1,
          signal: null,
          stdout: 'Retained output',
          stderr: 'offline'
        }
      if (mode === 'timeout')
        return {
          status: null,
          signal: 'SIGTERM',
          error: new Error('timed out'),
          stdout: 'Partial output',
          stderr: ''
        }
      return {
        status: 0,
        signal: null,
        stdout:
          mode === 'lost-ime' && probes > 0
            ? shown.replace('true', 'false')
            : actualRaw,
        stderr: ''
      }
    }
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      surface: 'android',
      native: true,
      runDir,
      deviceId: 'emulator-0000',
      fixture: { devices: { android: { id: 'emulator-0000', owned: true } } },
      binding: { source: '0'.repeat(40) },
      deadline: new AbortController().signal,
      steps: [],
      device: {
        platformInfo: async () => ({
          screenWidth: viewport.width,
          screenHeight: viewport.height
        }),
        hierarchy: async () => {
          calls.push('hierarchy')
          return tree()
        },
        assertVisible: async (args: Record<string, unknown>) => {
          calls.push(args)
          if (args.id === 'chat-composer' && args.focused === true)
            focusChecks++
          if (
            typeof args.text === 'string' &&
            /q|w|e/i.test(args.text) &&
            !['^Send$', '^Cancel reply$'].includes(args.text)
          )
            throw Error('Keyboard keys must never be queried')
          if (mode === 'query-failed')
            throw Object.assign(new Error('Actual focused selector failed'), {
              code: 'COMMAND_FAILED'
            })
          // Actual Android assertions may return an opaque id and zero geometry.
          return {
            element: {
              id: 'opaque',
              bounds: { x: 0, y: 0, width: 0, height: 0 }
            }
          }
        },
        screenshot: async () => captureImages[0]
      }
    }) as Chat2UI
    return {
      ui,
      calls,
      raw: actualRaw,
      probes: () => probes,
      focusChecks: () => focusChecks
    }
  }
  it('accepts positive shown legacy and current native-coordinate window formats', () => {
    expect(androidImeFrame(shown, viewport)).deep.equals({
      x: 0,
      y: 560,
      width: 400,
      height: 240
    })
    expect(
      androidImeFrame(
        'Window{0000 u0 InputMethod}\n mInputShown=true\n mFrame=[0,560][400,800]',
        viewport
      )
    ).deep.equals({ x: 0, y: 560, width: 400, height: 240 })
    expect(
      androidImeFrame(shown + 'mFrame=[0,560][400,800]', viewport)
    ).deep.equals({ x: 0, y: 560, width: 400, height: 240 })
  })
  for (const [name, raw] of [
    ['hidden', shown.replace('true', 'false')],
    [
      'stale-frame-without-positive-visibility',
      'Window{0000 u0 InputMethod}\n mFrame=[0,560][400,800]'
    ],
    ['conflicting-state', shown + 'mInputShown=false'],
    ['unknown-state', shown.replace('true', 'unknown')],
    [
      'ambiguous-frame',
      shown + 'mFrame=[0,560][400,800]\nmFrame=[0,570][400,800]'
    ],
    ['multiple-regions', shown + 'touchable region=SkRegion((0,570,400,800))'],
    [
      'complex-region',
      shown.replace('(0,560,400,800)', '(0,560,400,800)(0,100,200,300)')
    ],
    ['zero-frame', shown.replace('560,400,800', '800,400,800')],
    ['negative-frame', shown.replace('0,560,400,800', '-1,560,400,800')],
    ['outside-native-viewport', shown.replace('400,800', '401,900')],
    ['unsafe-integer', shown.replace('400,800', '9007199254740993,800')],
    ['wrong-window', shown.replace('InputMethod', 'Other')],
    ['contradictory-formats', shown + 'mFrame=[0,600][400,800]'],
    ['malformed-frame', shown + 'mFrame=[bad]'],
    [
      'valid-plus-malformed-frame',
      shown + 'mFrame=[0,560][400,800]\nmFrame=[bad]'
    ],
    ['valid-plus-malformed-region', shown + 'touchable region=bad'],
    [
      'frame-plus-malformed-region',
      'InputMethod\n isOnScreen=true\n mFrame=[0,560][400,800]\n touchable region=bad'
    ]
  ])
    it('rejects ' + name + ' without guessing keyboard visibility', () => {
      expect(() => androidImeFrame(raw, viewport)).throws()
    })

  it('uses only exact-owned read-only adb arguments and retains fresh raw provenance', async () => {
    const actual = model()
    const result = await actual.ui.readAndroidIme()
    expect(result.bounds).deep.equals({ x: 0, y: 560, width: 400, height: 240 })
    expect(readFileSync(result.rawPath, 'utf8')).equals(actual.raw)
    const command = actual.calls[0] as {
      argv: string[]
      options: { timeout: number }
    }
    expect(command.argv).deep.equals([
      '-s',
      'emulator-0000',
      'shell',
      'dumpsys',
      'window',
      'InputMethod'
    ])
    expect(command.options.timeout).at.most(5000).and.greaterThan(0)
    expect(actual.ui.steps.at(-1)?.outcome).equals('passed')
    expect(actual.calls).length(1)
  })
  for (const mode of ['hidden', 'transport', 'timeout'])
    it('retains actual raw/error output and rejects ' + mode, async () => {
      const actual = model(mode)
      await captureFailure(actual.ui.readAndroidIme())
      const step = actual.ui.steps.at(-1)!
      expect(step.outcome).equals('failed')
      expect(readFileSync(step.rawPath as string, 'utf8')).equals(
        mode === 'transport'
          ? 'Retained output'
          : mode === 'timeout'
            ? 'Partial output'
            : actual.raw
      )
      expect(typeof step.rawSha256).equals('string')
    })
  it('refuses an unowned serial before any adb observation', async () => {
    const actual = model()
    actual.ui.deviceId = 'emulator-0001'
    await captureFailure(actual.ui.readAndroidIme())
    expect(actual.calls).deep.equals([])
  })
  it('proves Search/compact-spotlight IME visibility without demanding composer focus', async () => {
    const actual = model('unfocused')
    await actual.ui.keyboardVisible()
    expect(actual.calls).length(1)
    expect(actual.probes()).equals(0)
  })
  it('reuses strict IME observation in the real E2 geometry callback without key reads', async () => {
    const actual = model()
    const copies: string[] = []
    actual.ui.publicBounds = async id =>
      id === 'chat-composer-band'
        ? { x: 20, y: 400, width: 360, height: 100 }
        : { x: 100, y: 450, width: 220, height: 40 }
    actual.ui.visible = async () => false
    actual.ui.device.copyTextFrom = async args => {
      copies.push(String(args.text))
      if (!['^Attach$', '^Send$'].includes(String(args.text)))
        throw Error('No key fallback allowed')
      return {
        element: {
          bounds: {
            x: args.text === '^Attach$' ? 24 : 332,
            y: 450,
            width: 44,
            height: 44
          }
        }
      }
    }
    actual.ui.shot = async () => {}
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual.ui,
      observations: []
    }) as Scenarios
    await scenario.nativeKeyboardGeometry()
    expect(copies).deep.equals(['^Attach$', '^Send$'])
    expect(
      (
        scenario.observations[0] as {
          nativeKeyboardGeometry: { keyboard: CaptureBox }
        }
      ).nativeKeyboardGeometry.keyboard
    ).deep.equals({ x: 0, y: 560, width: 400, height: 240 })
    expect(
      actual.ui.steps.find(
        step => step.name === 'Read-only owned Android IME window'
      )?.outcome
    ).equals('passed')
  })
  it('rejects already-aborted observation before any adb read', async () => {
    const actual = model()
    const controller = new AbortController()
    controller.abort()
    await captureFailure(
      actual.ui.readAndroidIme({ signal: controller.signal })
    )
    expect(actual.calls).deep.equals([])
  })
  it('combines exact enabled/focused selector proof with independent positive native geometry', async () => {
    const actual = model()
    const result = await readAndroidComposerKeyboard(
      actual.ui,
      AbortSignal.timeout(1000)
    )
    expect(result.geometry.composer).deep.equals({
      x: 100,
      y: 450,
      width: 220,
      height: 40
    })
    expect(actual.calls[0]).deep.equals({
      id: 'chat-composer',
      focused: true,
      enabled: true,
      timeout: 2000
    })
    expect(result.nodes.find(n => n.text === 'Send')?.enabled).equals(false)
    await actual.ui.assertKeyboard()
    expect(actual.ui.steps.at(-1)?.outcome).equals('passed')
  })
  for (const mode of [
    'unfocused',
    'disabled',
    'duplicate-editor',
    'missing-band',
    'missing-editor',
    'outside-editor',
    'zero-editor',
    'overlap',
    'query-failed'
  ])
    it('rejects focused composer proof with ' + mode, async () => {
      const actual = model(mode)
      await captureFailure(actual.ui.assertKeyboard())
      expect(
        actual.calls.some(
          call => typeof call === 'object' && call != null && 'text' in call
        )
      ).equals(false)
    })
  it('requires two fresh IME/focus/control observations with actual stable raw frames and disabled Send visible', async () => {
    const actual = model()
    const proof = await observeComposerCaptureReady(
      actual.ui,
      { focused: true, reply: true },
      1500
    )
    expect(proof.composerCaptureReady).equals(true)
    expect(
      actual.ui.steps.find(
        step => step.name === 'Settled composer capture readiness'
      )?.outcome
    ).equals('passed')
    expect(actual.probes()).at.least(2)
    expect(
      actual.ui.steps.filter(
        step => step.name === 'Read-only owned Android IME window'
      )
    ).length.at.least(2)
  })
  for (const mode of [
    'lost-ime',
    'duplicate-send',
    'outside-send',
    'zero-attach',
    'negative-attach',
    'nonfinite-attach',
    'zero-send',
    'negative-send',
    'nonfinite-send',
    'zero-cancel',
    'negative-cancel',
    'nonfinite-cancel',
    'overlay',
    'geometry-change'
  ])
    it('never accepts Android capture readiness after ' + mode, async () => {
      const actual = model(mode)
      await captureFailure(
        observeComposerCaptureReady(
          actual.ui,
          { focused: true, reply: true },
          120
        )
      )
      expect(
        actual.ui.steps.find(
          step => step.name === 'Settled composer capture readiness'
        )?.outcome
      ).equals('failed')
    })

  async function adjacentFrames(
    mode: string,
    work: (actual: {
      ui: Chat2UI
      probes: () => number
      shots: () => number
      frames: Buffer[]
    }) => Promise<void>
  ): Promise<void> {
    const frames =
      mode === 'clock-change'
        ? [
            composerPng(),
            composerPng([{ box: [12, 8, 8, 4], color: [0, 0, 0, 255] }])
          ]
        : mode === 'png'
          ? captureImages
          : captureJpegs
    const actualNow = Date.now
    let offset = 0
    let shots = 0
    Date.now = () => actualNow() + offset
    const actual = model()
    const hierarchy = actual.ui.device.hierarchy
    let measuredFocus = 0
    actual.ui.device.hierarchy = async () => {
      const tree = (await hierarchy()) as { children: unknown[] }
      // Cost each full semantic focus probe; additional control reads remain genuinely fresh.
      if (actual.focusChecks() > measuredFocus) {
        measuredFocus = actual.focusChecks()
        offset +=
          mode === 'overall-abort'
            ? 0
            : ['motion', 'clock-change'].includes(mode)
              ? 31000
              : 4500
        if (mode === 'invalid-middle' && measuredFocus === 2)
          tree.children.push({ id: 'chat-picker-scene' })
      }
      return tree
    }
    Object.assign(actual.ui.device, {
      screenshot: async ({ signal }: { signal: AbortSignal }) => {
        expect(signal.aborted).equals(false)
        shots += 1
        offset += ['motion', 'clock-change'].includes(mode) ? 1100 : 100
        if (mode === 'image-transport')
          throw new Error('Raw image transport disconnected')
        if (mode === 'slow-first' && shots === 1)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2100)
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(signal.reason)
              },
              { once: true }
            )
          })
        if (mode === 'overall-abort')
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(signal.reason)
              },
              {
                once: true
              }
            )
          })
        if (mode === 'invalid-format') return Buffer.from('No image')
        if (mode === 'truncated-jpeg') return captureJpegs[0].subarray(0, -2)
        if (mode === 'truncated-png') return captureImages[0].subarray(0, -12)
        return frames[
          ['motion', 'clock-change'].includes(mode)
            ? shots % 2
            : actual.focusChecks() % 2
        ]
      }
    })
    try {
      await work({
        ...actual,
        probes: actual.focusChecks,
        shots: () => shots,
        frames
      })
    } finally {
      Date.now = actualNow
    }
  }
  for (const mode of ['jpeg', 'png'])
    it(
      'pairs exact adjacent raw ' +
        mode +
        ' frames across expensive fresh guards',
      async () => {
        await adjacentFrames(mode, async actual => {
          const start = Date.now()
          const proof = await observeComposerCaptureReady(actual.ui, {
            focused: true,
            reply: true
          })
          expect(proof.composerCaptureReady).equals(true)
          expect(Date.now() - start)
            .greaterThan(9000)
            .and.lessThan(90000)
          expect(actual.probes()).equals(2)
          expect(actual.shots()).equals(4)
          const observation = captureObservation(actual.ui)
          expect(observation.samples).length(2)
          expect(observation.samples[0].image?.sha256).not.equals(
            observation.samples[1].image?.sha256
          )
          for (const sample of observation.samples) {
            expect(sample.rawPairStable).equals(true)
            expect(sample.rawPairStableForMs).at.least(200)
            expect(sample.rawFrames).length(2)
            const [before, after] = sample.rawFrames!
            expect(before.sha256).equals(after.sha256)
            expect(after.comparedWith).equals(before.path)
            for (const frame of sample.rawFrames!) {
              expect(frame.path).matches(
                mode === 'jpeg' ? /\.raw\.jpg$/ : /\.raw\.png$/
              )
              expect(frame.at).a('string')
              expect(frame.width).equals(1)
              expect(frame.height).equals(1)
              expect(
                actual.frames.some(bytes =>
                  bytes.equals(readFileSync(frame.path))
                )
              ).equals(true)
            }
            expect(sample.publicAccessibility?.focused).equals(true)
            expect(sample.publicAccessibility?.keyboard).equals(true)
            expect(sample.publicAccessibility?.reply).equals(true)
          }
        })
      }
    )
  it('resets the reference after a real invalid middle probe despite stable frame pairs', async () => {
    await adjacentFrames('invalid-middle', async actual => {
      await observeComposerCaptureReady(actual.ui, {
        focused: true,
        reply: true
      })
      expect(actual.probes()).equals(4)
      const observation = captureObservation(actual.ui)
      expect(observation.samples.map(sample => sample.ready)).deep.equals([
        true,
        false,
        true,
        true
      ])
    })
  })
  it('finishes an in-flight Android capture after burst expiry using the overall deadline', async () => {
    await adjacentFrames('slow-first', async actual => {
      await observeComposerCaptureReady(actual.ui, {
        focused: true,
        reply: true
      })
      expect(actual.probes()).equals(3)
      const observation = captureObservation(actual.ui)
      expect(
        observation.samples.map(sample => sample.rawPairStable)
      ).deep.equals([false, true, true])
    })
  })
  for (const mode of [
    'motion',
    'clock-change',
    'image-transport',
    'overall-abort',
    'invalid-format',
    'truncated-jpeg',
    'truncated-png'
  ])
    it('rejects adjacent Android raw proof with ' + mode, async () => {
      await adjacentFrames(mode, async actual => {
        await captureFailure(
          observeComposerCaptureReady(
            actual.ui,
            { focused: true, reply: true },
            mode === 'overall-abort' ? 150 : 90000
          )
        )
        expect(
          actual.ui.steps.find(
            step => step.name === 'Settled composer capture readiness'
          )?.outcome
        ).equals('failed')
      })
    })
})

describe('compatibility harness route and coordinate boundaries', () => {
  it('opens only the exact I3 bench route and retains ordinary chat navigation', async () => {
    const calls: unknown[] = []
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      scenario: 'I3',
      native: false,
      surface: 'web-narrow',
      dom: async (script: string) => {
        calls.push(script)
        return {}
      }
    }) as Chat2UI
    await ui.open('/dev/chat-bench')
    await ui.open('/chat/example')
    expect(calls).has.length(2)
    for (const scenario of ['I1', 'I2', 'E1', 'capture']) {
      Object.assign(ui, { scenario })
      await captureFailure(ui.open('/dev/chat-bench'))
    }
    Object.assign(ui, { scenario: 'I3' })
    for (const path of [
      '/dev/other',
      '/dev/chat-bench/',
      '/dev/chat-bench?x=1',
      '/dev/chat-bench#x',
      'https://example.test/dev/chat-bench'
    ])
      await captureFailure(ui.open(path))
    expect(calls).has.length(2)
    Object.assign(ui, {
      native: true,
      surface: 'android',
      fixture: { scheme: 'teamstation' },
      device: {
        openLink: async (args: unknown) => {
          calls.push(args)
        }
      }
    })
    await ui.open('/dev/chat-bench')
    expect(calls[2]).deep.equals({ link: 'teamstation://dev/chat-bench' })
  })
  it('passes an observed center as bounded numeric coordinates instead of a percentage point string', async () => {
    const calls: Array<Record<string, unknown>> = []
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      device: {
        tapOnPoint: async (
          args: Record<string, unknown>,
          options: { signal: AbortSignal }
        ) => {
          expect(options.signal).instanceOf(AbortSignal)
          expect(options.signal.aborted).equals(false)
          calls.push(args)
        }
      }
    }) as Chat2UI
    await ui.tapObserved({ bounds: { x: 17, y: 499, width: 341, height: 56 } })
    expect(calls).deep.equals([{ x: 188, y: 527 }])
  })
})

describe('identity safety row ownership', () => {
  function model(
    mode = 'normal',
    native = false,
    surface = native ? 'android' : 'web-narrow'
  ): {
    scenario: Scenarios
    expected: string
    calls: unknown[]
    close: () => void
  } {
    const peer = userIdOfGumbo(2)
    const other = userIdOfGumbo(3)
    const viewer = userIdOfGumbo(1)
    const expected = '12345'.repeat(12)
    const calls: unknown[] = []
    let opened = false
    let coachY = mode === 'below-footer' ? 770 : 180
    let memberY = 100
    let pendingScroll = mode === 'moving-row'
    const finishScroll = (): void => {
      if (!pendingScroll) return
      pendingScroll = false
      coachY += 80
      memberY += 80
    }
    const document = new JSDOM(
      `<div data-testid="chat-info-members"><button data-testid="chat-info-member-${other}" aria-label="Safety number with Kyle Tucker, Member"><span>Kyle Tucker</span><span>Member</span></button><button data-testid="chat-info-member-${peer}" aria-label="Safety number with Kyle Tucker, Coach, Moderator"><span>Kyle Tucker</span><span>Coach</span></button></div>`,
      { runScripts: 'outside-only' }
    )
    const buttons = Array.from(
      document.window.document.querySelectorAll('button')
    )
    for (const [index, button] of buttons.entries())
      button.getBoundingClientRect = () =>
        new document.window.DOMRect(10, index === 0 ? memberY : coachY, 380, 60)
    document.window.document.elementFromPoint = (x, y) =>
      buttons.find(button => {
        const b = button.getBoundingClientRect()
        return x >= b.x && x < b.right && y >= b.y && y < b.bottom
      })?.lastElementChild ?? null
    if (mode === 'ambiguous-dom')
      document.window.document
        .querySelector('[data-testid]')!
        .append(buttons[1].cloneNode(true))
    const ordinary = (): PublicNode[] => [
      {
        text: 'Back',
        type: 'Button',
        bounds: { x: 0, y: 0, width: 80, height: 40 }
      },
      {
        text: 'Home',
        type: 'Button',
        bounds: { x: 0, y: 740, width: 80, height: 50 }
      },
      {
        id: 'chat-info-member-' + other,
        text: 'Safety number with Kyle Tucker, Member',
        type: surface === 'android' ? 'android.view.View' : 'Button',
        bounds: { x: 10, y: 100, width: 380, height: 60 }
      },
      {
        text: 'Member',
        type: 'TextView',
        bounds: { x: 80, y: 130, width: 120, height: 20 }
      },
      {
        id: 'chat-info-member-' + peer,
        text:
          mode === 'wrong-spoken-role'
            ? 'Safety number with Kyle Tucker, Member'
            : 'Safety number with Kyle Tucker, Coach, Moderator',
        type: surface === 'android' ? 'android.view.View' : 'Button',
        bounds: { x: 10, y: coachY, width: 380, height: 60 }
      },
      {
        text: 'Coach',
        type: 'TextView',
        bounds: { x: 80, y: coachY + 30, width: 120, height: 20 }
      }
    ]
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native,
      surface,
      metrics: () => ({ width: 400, height: 800 }),
      nodes: async () =>
        opened
          ? Array.from({ length: 12 }, (_, i) => ({
              id: 'chat-safety-group-' + i,
              text: mode === 'wrong-digits' && i === 0 ? '54321' : '12345'
            }))
          : ordinary().filter(node => !native || node.type !== 'TextView'),
      dom: async (script: string) =>
        document.window.eval('(()=>{' + script + '})()'),
      text: async (label: string) => {
        calls.push(label)
      },
      shot: async (kind: string) => {
        calls.push(kind)
      },
      device: {
        platformInfo: async () => ({ screenWidth: 400, screenHeight: 800 }),
        scrollUntilVisible: async (args: unknown) => {
          calls.push(args)
        },
        scroll: async (args: unknown) => {
          calls.push(args)
          coachY = 180
        },
        tapOnPoint: async (args: { x: number; y: number }) => {
          calls.push(args)
          finishScroll()
          const hit = document.window.document.elementFromPoint(args.x, args.y)
          expect(hit?.closest('button')?.getAttribute('data-testid')).equals(
            'chat-info-member-' + peer,
            'A stale coordinate must not open another member'
          )
          opened = true
        },
        tapOn: async (
          args: { id: string },
          options: { signal: AbortSignal }
        ) => {
          calls.push(args)
          expect(options.signal).instanceof(AbortSignal)
          finishScroll()
          const button = buttons.find(
            node => node.getAttribute('data-testid') === args.id
          )
          expect(button, 'Exact observed peer selector required').not.equals(
            undefined
          )
          const b = button!.getBoundingClientRect()
          const hit = document.window.document.elementFromPoint(
            b.x + b.width / 2,
            b.y + b.height / 2
          )
          expect(hit?.closest('button')).equals(buttons[1])
          opened = true
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      viewerId: viewer,
      ui,
      observations: [],
      f: {
        members: [
          { userId: peer, name: 'Kyle Tucker', role: 'Coach' },
          {
            userId: other,
            name: 'Kyle Tucker',
            role: mode === 'ambiguous-role' ? 'Coach' : 'Member'
          }
        ]
      },
      openInfo: async () => {
        calls.push('Info')
      },
      openGroup: async () => {
        calls.push('Group')
      }
    }) as Scenarios
    return {
      scenario,
      expected,
      calls,
      close: () => {
        document.window.close()
      }
    }
  }
  for (const native of [false, true])
    it(
      'opens the role-qualified peer among duplicate names with exact safety digits: ' +
        (native ? 'Android View hierarchy model' : 'real DOM model'),
      async () => {
        const actual = model('normal', native)
        try {
          await actual.scenario.identitySafety(
            userIdOfGumbo(2),
            actual.expected
          )
          expect(actual.calls).deep.includes(
            native
              ? { x: 200, y: 210 }
              : { id: 'chat-info-member-' + userIdOfGumbo(2) }
          )
          expect(actual.calls).includes('identity-safety')
          expect(actual.calls).includes('Done')
          expect(actual.calls).includes('Group')
        } finally {
          actual.close()
        }
      }
    )
  it('uses the exact iOS row and its spoken role when descendant role text is absent from accessibility', async () => {
    const actual = model('normal', true, 'ios')
    try {
      await actual.scenario.identitySafety(userIdOfGumbo(2), actual.expected)
      expect(actual.calls).deep.includes({ x: 200, y: 210 })
      expect(actual.calls).deep.includes({
        element: { id: 'chat-info-member-' + userIdOfGumbo(2) },
        direction: 'DOWN',
        timeout: 15000
      })
    } finally {
      actual.close()
    }
  })
  it('rejects the exact native row if its spoken role belongs to a different member', async () => {
    const actual = model('wrong-spoken-role', true, 'ios')
    try {
      const failure = await captureFailure(
        actual.scenario.identitySafety(userIdOfGumbo(2), actual.expected)
      )
      expect(String(failure)).includes(
        'Exact peer short name and visible role required'
      )
      expect(actual.calls).not.includes('identity-safety')
    } finally {
      actual.close()
    }
  })
  it('scrolls the observed peer clear of the footer before its exact selector tap', async () => {
    const actual = model('below-footer')
    try {
      await actual.scenario.identitySafety(userIdOfGumbo(2), actual.expected)
      expect(actual.calls).deep.includes({ direction: 'DOWN' })
      expect(actual.calls).deep.includes({
        id: 'chat-info-member-' + userIdOfGumbo(2)
      })
    } finally {
      actual.close()
    }
  })
  it('keeps the exact browser peer when queued scrolling moves another member under the observed point', async () => {
    const actual = model('moving-row')
    try {
      await actual.scenario.identitySafety(userIdOfGumbo(2), actual.expected)
      expect(actual.calls).deep.includes({
        id: 'chat-info-member-' + userIdOfGumbo(2)
      })
      expect(actual.calls).not.deep.includes({ x: 200, y: 210 })
      expect(actual.calls).includes('identity-safety')
      expect(actual.calls).includes('Done')
    } finally {
      actual.close()
    }
  })
  for (const mode of ['ambiguous-role', 'ambiguous-dom', 'wrong-digits'])
    it(
      'rejects ' + mode + ' without claiming successful safety verification',
      async () => {
        const actual = model(mode)
        try {
          const failure = await captureFailure(
            actual.scenario.identitySafety(userIdOfGumbo(2), actual.expected)
          )
          expect(String(failure)).includes(
            mode === 'wrong-digits'
              ? 'Actual installed safety digits must match'
              : mode === 'ambiguous-dom'
                ? 'Unique actual name and role'
                : 'Unique public safety name and role'
          )
          expect(actual.calls).not.includes('identity-safety')
        } finally {
          actual.close()
        }
      }
    )
})

describe('native installed legacy reply navigation', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })
  function model(
    mode = 'resolved',
    native = true,
    surface = 'ios'
  ): {
    scenario: Scenarios
    baseline: { text: Chat2Message; reply: Chat2Message }
    calls: unknown[]
  } {
    const viewer = userIdOfGumbo(1)
    const baseline = {
      text: {
        id: 'msg_original',
        seq: 5,
        body: 'Original legacy text.',
        authorId: viewer
      },
      reply: {
        id: 'msg_reply',
        seq: 236,
        body: 'Preserved legacy reply.',
        authorId: userIdOfGumbo(2)
      }
    }
    const calls: unknown[] = []
    const runDir = mkdtempSync(join(tmpdir(), 'legacy-scoped-read-'))
    directories.push(runDir)
    const clipped = mode.startsWith('clipped-')
    const row = {
      x: clipped ? 126 : 20,
      y: clipped
        ? mode === 'clipped-above'
          ? 0
          : mode === 'clipped-indeterminate'
            ? 700
            : 2543
        : mode === 'float-edge'
          ? 178.66664632161456
          : mode === 'occluded-edge'
            ? 170.1666717529297
            : ['above-header', 'no-progress'].includes(mode)
              ? -131
              : mode === 'below-composer'
                ? 650
                : 200,
      width: clipped ? 672 : 340,
      height: clipped ? -143 : mode === 'tall-file' ? 900 : 240
    }
    const quote = { x: 40, y: 220, width: 300, height: 80 }
    interface Tree extends PublicNode {
      children?: Tree[]
    }
    const hierarchy = (): Tree => {
      const label =
        mode === 'unavailable'
          ? 'Jump to message from Former member: Message unavailable'
          : 'Jump to message from You: Original legacy text.'
      const currentQuote: Tree = {
        type: mode === 'wrong-type' ? 'Other' : 'Button',
        text: mode === 'wrong-label' ? 'Another quote' : label,
        bounds:
          mode === 'outside-row'
            ? { ...quote, y: 100 }
            : mode === 'offscreen'
              ? { ...quote, x: -10 }
              : mode === 'nonfinite'
                ? { ...quote, width: NaN }
                : quote
      }
      return {
        type: 'ScrollView',
        bounds: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          {
            id: 'chat-message-msg_other',
            type: 'ViewGroup',
            bounds: { x: 20, y: 20, width: 340, height: 160 },
            children: [
              {
                type: 'Button',
                text: label,
                bounds: { x: 40, y: 30, width: 300, height: 60 }
              },
              {
                type: 'TextView',
                text: baseline.reply.body,
                bounds: { x: 40, y: 100, width: 300, height: 40 }
              }
            ]
          },
          {
            id:
              mode === 'wrong-row'
                ? 'chat-message-msg_wrong'
                : 'chat-message-msg_reply',
            type: 'ViewGroup',
            bounds: { ...row },
            children: [
              ...(mode === 'unresolved' || mode === 'wrong-parent'
                ? []
                : [currentQuote]),
              ...(mode === 'ambiguous'
                ? [{ ...currentQuote, bounds: { ...quote, y: 305 } }]
                : []),
              {
                id: 'chat-message-body-msg_reply',
                type: 'ViewGroup',
                bounds: {
                  x: row.x + 20,
                  y: row.y + 120,
                  width: row.width - 40,
                  height: 40
                },
                children: [
                  {
                    type: 'TextView',
                    text:
                      mode === 'wrong-body'
                        ? baseline.reply.body.toUpperCase()
                        : baseline.reply.body,
                    bounds: {
                      x: row.x + 20,
                      y: row.y + 120,
                      width: row.width - 40,
                      height: 40
                    }
                  }
                ]
              }
            ]
          },
          ...(mode === 'wrong-parent' ? [currentQuote] : [])
        ]
      }
    }
    const read = (): Tree => {
      calls.push({ nativeHierarchy: surface })
      if (mode === 'transport') throw Error('Actual native transport failure')
      return hierarchy()
    }
    const deadline = AbortSignal.timeout(10000)
    const move = (args: unknown): void => {
      calls.push({ swipe: args })
      if (clipped && mode !== 'clipped-no-progress') {
        row.y = 700
        row.height = 410
      } else if (
        !['no-progress', 'occluded-edge', 'clipped-no-progress'].includes(mode)
      )
        row.y = mode === 'tall-file' ? 116 : 200
    }
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native,
      deadline,
      surface,
      runDir,
      iosRaw: async () => {
        const nodes: unknown[] = []
        const visit = (node: Tree, parentIndex?: number): void => {
          const index = nodes.length
          nodes.push({
            index,
            parentIndex,
            type:
              node.type === 'TextView'
                ? 'StaticText'
                : node.type === 'ViewGroup'
                  ? 'Other'
                  : node.type,
            identifier: node.id,
            label: node.text,
            rect: node.bounds
          })
          for (const child of node.children ?? []) visit(child, index)
        }
        visit(read())
        return Buffer.from(JSON.stringify({ nodes }))
      },
      visible: async () => true,
      id: async (id: string) => {
        calls.push({ latest: id })
      },
      present: async (id: string) => {
        calls.push({ present: id })
      },
      device: {
        assertVisible: async (selector: { id?: string; text?: string }) => {
          calls.push(selector)
          return {
            element: {
              found: true,
              id: 'e16',
              bounds: { x: 0, y: 0, width: 0, height: 0 }
            }
          }
        },
        hierarchy: async () => read(),
        platformInfo: async () => ({
          screenWidth: clipped ? 1080 : 400,
          screenHeight: clipped ? 2400 : 800
        }),
        swipe: async (args: unknown) => {
          move(args)
        },
        dragAndDrop: async (
          args: Record<string, unknown>,
          options?: { signal: AbortSignal }
        ) => {
          expect(surface).equals('ios')
          expect(args.holdDuration).equals(16)
          expect(args.duration).equals(350)
          expect(options?.signal).equals(deadline)
          const from = args.from as { point: string }
          const to = args.to as { point: string }
          expect(from.point).matches(/^\d+,\d+$/)
          expect(to.point).matches(/^\d+,\d+$/)
          const start = from.point.split(',').map(Number)
          const end = to.point.split(',').map(Number)
          move({
            startX: start[0],
            startY: start[1],
            endX: end[0],
            endY: end[1],
            duration: args.duration
          })
        },
        tapOnPoint: async (args: unknown) => {
          calls.push({ tap: args })
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      viewerId: viewer,
      ui,
      observations: [],
      readingBand: async () =>
        clipped
          ? { top: 432, bottom: 1929 }
          : ['float-edge', 'occluded-edge'].includes(mode)
            ? { top: 170.6666717529297, bottom: 700.6666870117188 }
            : { top: 100, bottom: 700 },
      targetBounds: async () => ({ ...row }),
      anchor: async (target: Chat2Message) => {
        calls.push({ anchor: target.id })
      }
    }) as Scenarios
    return { scenario, baseline, calls }
  }
  for (const surface of ['ios', 'android'])
    for (const mode of ['resolved', 'unavailable'])
      it(
        'uses the exact recent reply and its observed ' +
          mode +
          ' quote among duplicate global labels on ' +
          surface,
        async () => {
          const actual = model(mode, true, surface)
          await actual.scenario.identityLegacyAnchor(
            actual.baseline.text,
            actual.baseline
          )
          expect(actual.calls[0]).deep.equals({ latest: 'chat-jump-latest' })
          expect(actual.calls[1]).deep.equals({ anchor: 'msg_reply' })
          expect(actual.calls).deep.includes({ tap: { x: 190, y: 260 } })
          expect(actual.calls.at(-1)).deep.equals({
            present: 'chat-bubble-msg_original'
          })
          const proof = actual.scenario.observations.find(
            p => p.kind === 'quote'
          )
          expect((proof?.element as PublicNode).text).equals(
            mode === 'resolved'
              ? 'Jump to message from You: Original legacy text.'
              : 'Jump to message from Former member: Message unavailable'
          )
          expect(
            actual.calls.some(
              call => typeof call === 'object' && call != null && 'text' in call
            )
          ).equals(false)
        }
      )
  for (const mode of ['above-header', 'below-composer', 'tall-file'])
    it(
      'frames the actual ' +
        mode +
        ' region with a vertical measured gesture before scoped body verification',
      async () => {
        const actual = model(mode)
        await actual.scenario.identityLegacyBody(actual.baseline.reply)
        const swipe = actual.calls.find(
          call => typeof call === 'object' && call != null && 'swipe' in call
        ) as {
          swipe: { startX: number; endX: number; startY: number; endY: number }
        }
        expect(swipe.swipe.startX).equals(swipe.swipe.endX)
        expect(
          mode === 'above-header'
            ? swipe.swipe.endY > swipe.swipe.startY
            : swipe.swipe.endY < swipe.swipe.startY
        ).equals(true)
        const proof = actual.scenario.observations.find(p => p.kind === 'body')
        expect((proof?.element as PublicNode).text).equals(
          'Preserved legacy reply.'
        )
      }
    )
  for (const mode of ['no-progress', 'wrong-body'])
    it(
      'rejects native ' + mode + ' instead of claiming the exact readable body',
      async () => {
        const actual = model(mode)
        const failure = await captureFailure(
          actual.scenario.identityLegacyBody(actual.baseline.reply)
        )
        expect(String(failure)).includes(
          mode === 'no-progress'
            ? 'native legacy reader progress'
            : 'Exact native legacy body required'
        )
        if (mode === 'no-progress') {
          expect(actual.calls).has.length(1)
          expect(
            actual.calls.every(
              call =>
                typeof call === 'object' && call != null && 'swipe' in call
            )
          ).equals(true)
        }
      }
    )
  it('accepts the observed fractional top edge without issuing a spurious native gesture', async () => {
    const actual = model('float-edge')
    await actual.scenario.identityLegacyBody(actual.baseline.reply)
    expect(
      actual.calls.some(
        call => typeof call === 'object' && call != null && 'swipe' in call
      )
    ).equals(false)
    expect(actual.scenario.observations.some(p => p.kind === 'body')).equals(
      true
    )
  })
  it('still rejects actual header occlusion when a normal measured gesture makes no progress', async () => {
    const actual = model('occluded-edge')
    const failure = await captureFailure(
      actual.scenario.identityLegacyBody(actual.baseline.reply)
    )
    expect(String(failure)).includes('native legacy reader progress')
    expect(actual.calls).has.length(1)
    expect(actual.scenario.observations.some(p => p.kind === 'body')).equals(
      false
    )
  })
  it('retains the exact browser body regex without native framing', async () => {
    const actual = model('resolved', false)
    await actual.scenario.identityLegacyBody(actual.baseline.reply)
    expect(actual.calls).deep.equals([{ text: '^Preserved legacy reply\\.$' }])
  })
  it('retains browser navigation without native controls or quote queries', async () => {
    const actual = model('resolved', false)
    await actual.scenario.identityLegacyAnchor(
      actual.baseline.text,
      actual.baseline
    )
    expect(actual.calls).deep.equals([{ anchor: 'msg_original' }])
  })
  it('returns to latest before revealing the recent reply or file from an old reader position', async () => {
    const actual = model()
    const file = { ...actual.baseline.reply, id: 'msg_file', seq: 239 }
    for (const target of [actual.baseline.reply, file])
      await actual.scenario.identityLegacyAnchor(target, actual.baseline)
    expect(actual.calls).deep.equals([
      { latest: 'chat-jump-latest' },
      { anchor: 'msg_reply' },
      { latest: 'chat-jump-latest' },
      { anchor: 'msg_file' }
    ])
  })
  for (const mode of [
    'wrong-row',
    'wrong-label',
    'wrong-type',
    'outside-row',
    'offscreen',
    'nonfinite',
    'unresolved',
    'ambiguous',
    'wrong-parent',
    'transport'
  ])
    it(
      'rejects ' + mode + ' without a quote tap or original-message claim',
      async () => {
        const actual = model(mode)
        await captureFailure(
          actual.scenario.identityLegacyAnchor(
            actual.baseline.text,
            actual.baseline
          )
        )
        expect(
          actual.calls.some(
            call =>
              typeof call === 'object' &&
              call != null &&
              ('tap' in call || 'present' in call)
          )
        ).equals(false)
        if (mode === 'transport') expect(actual.calls).has.length(3)
      }
    )
  for (const mode of ['wrong-parent', 'ambiguous', 'wrong-body'])
    it(
      'rejects Android scoped ' +
        mode +
        ' with no dependency on assertVisible return text',
      async () => {
        const actual = model(mode, true, 'android')
        await captureFailure(
          actual.scenario.identityLegacyAnchor(
            actual.baseline.text,
            actual.baseline
          )
        )
        expect(
          actual.calls.some(
            call =>
              typeof call === 'object' &&
              call != null &&
              ('tap' in call || 'present' in call)
          )
        ).equals(false)
      }
    )
  for (const mode of ['clipped-below', 'clipped-above'])
    it(
      'reveals observed Android ' +
        mode +
        ' bounds before requiring positive dimensions and exact text',
      async () => {
        const actual = model(mode, true, 'android')
        await actual.scenario.identityLegacyBody(actual.baseline.reply)
        const proof = actual.scenario.observations.find(
          p => p.legacyBody === 'msg_reply'
        )!
        const samples = proof.samples as Array<{
          height?: number
          clipped?: boolean
        }>
        expect(samples[0]).includes({ height: -143, clipped: true })
        expect(
          samples.some(
            sample => sample.height === 410 && sample.clipped === false
          )
        ).equals(true)
        expect(
          actual.scenario.observations.some(p => p.kind === 'body')
        ).equals(true)
        const gesture = (
          actual.calls[0] as { swipe: { startY: number; endY: number } }
        ).swipe
        expect(
          mode === 'clipped-below'
            ? gesture.endY < gesture.startY
            : gesture.endY > gesture.startY
        ).equals(true)
      }
    )
  for (const mode of ['clipped-no-progress', 'clipped-indeterminate'])
    it(
      'rejects Android ' +
        mode +
        ' without accepting clipped geometry as visible',
      async () => {
        const actual = model(mode, true, 'android')
        const failure = await captureFailure(
          actual.scenario.identityLegacyBody(actual.baseline.reply)
        )
        expect(String(failure)).includes(
          mode === 'clipped-no-progress'
            ? 'native legacy reader progress'
            : 'observed offscreen direction'
        )
        expect(
          actual.scenario.observations.some(p => p.kind === 'body')
        ).equals(false)
        expect(actual.calls).has.length(mode === 'clipped-no-progress' ? 1 : 0)
      }
    )
})

describe('I3 native bench cold-link lifecycle', () => {
  async function run(surface: string, fault?: string): Promise<unknown[]> {
    const calls: unknown[] = []
    const ui = {
      surface,
      native: surface === 'ios' || surface === 'android',
      fixture: { appId: 'app.example.test' },
      step: async (_name: string, action: () => Promise<void>) => {
        await action()
      },
      open: async (path: string) => {
        calls.push({ open: path })
      },
      text: async (text: string) => {
        calls.push({ tap: text })
      },
      shot: async () => {
        calls.push('storage-shot')
      },
      device: {
        stopApp: async (args: unknown) => {
          calls.push({ stop: args })
          if (fault === 'stop') throw Error('Actual stop failed')
        },
        assertVisible: async (args: { text: string }) => {
          calls.push({ visible: args.text })
          if (fault === 'heading' && args.text === '^Chat crypto bench$')
            throw Error('Actual bench heading absent')
        },
        assertNotVisible: async (args: { text: string }) => {
          calls.push({ absent: args.text })
        }
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      observations: []
    }) as Scenarios
    if (fault == null) await scenario.I3()
    else {
      const error = await captureFailure(scenario.I3())
      expect(String(error)).includes(
        fault === 'stop' ? 'Actual stop failed' : 'Actual bench heading absent'
      )
    }
    return calls
  }
  for (const surface of ['ios', 'android'])
    it(
      'stops ' +
        surface +
        ' before opening the bench link and requires its heading before unchanged storage checks',
      async () => {
        const calls = await run(surface)
        expect(calls.slice(0, 5)).deep.equals([
          { stop: { appId: 'app.example.test' } },
          { open: '/dev/chat-bench' },
          { visible: '^Chat crypto bench$' },
          { visible: '^vectors ok$' },
          { tap: 'Check saved chat compatibility' }
        ])
        expect(calls).deep.includes({ visible: '^identity storage ok$' })
        expect(calls).deep.includes({ absent: '^identity storage failed$' })
        expect(calls.at(-1)).equals('storage-shot')
      }
    )
  it('retains the existing warm navigation on web-wide', async () => {
    const calls = await run('web-wide')
    expect(calls.slice(0, 2)).deep.equals([
      { open: '/dev/chat-bench' },
      { visible: '^vectors ok$' }
    ])
    expect(
      calls.some(
        call => typeof call === 'object' && call != null && 'stop' in call
      )
    ).equals(false)
  })
  for (const surface of ['ios', 'android'])
    for (const fault of ['stop', 'heading'])
      it(
        'does not claim vectors or storage readiness after an ' +
          surface +
          ' ' +
          fault +
          ' failure',
        async () => {
          const calls = await run(surface, fault)
          expect(calls).not.deep.includes({ visible: '^vectors ok$' })
          expect(calls).not.includes('storage-shot')
          if (fault === 'stop') expect(calls).has.length(1)
        }
      )
})

describe('I2 mixed-account legacy reply selection', () => {
  async function selection(
    surface: string,
    wrongAuthor = false
  ): Promise<{
    selected: Chat2Message[]
    target: Chat2Message
    error: unknown
    stopped: Error
  }> {
    const peerId = userIdOfGumbo(5)
    const target: Chat2Message = {
      id: 'msg-pre-upgrade-peer',
      seq: 231,
      body: 'Practice update: bring water.',
      authorId: wrongAuthor ? userIdOfGumbo(6) : peerId
    }
    const distantOriginal: Chat2Message = {
      id: 'msg-installed-profile-original',
      seq: 6,
      body: 'Earlier note from an installed profile.',
      authorId: userIdOfGumbo(7)
    }
    const selected: Chat2Message[] = []
    const stopped = Error('Reply target boundary observed')
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      viewerKey: 'Fresh',
      viewerId: 'usr_11112LJ7YLqvVc8DmhwPNw',
      ui: { surface },
      f: {
        identityCompatibility: {
          fullWidthActors: ['Fresh'],
          legacy: { [surface]: { text: distantOriginal } }
        },
        actors: { Fresh: { provider: {} } },
        messages: { target }
      },
      check: async (_name: string, action: () => Promise<void>) => {
        await action()
      },
      client: async () => ({
        whoAmI: async () => ({ gumboId: null }),
        myChatKeys: async () => ({ identity: { id: 'cid-original' } })
      }),
      signIn: async () => {},
      openGroup: async () => {},
      protocolPeer: async () => ({
        client: { whoAmI: async () => ({ id: peerId }) }
      }),
      reply: async (message: Chat2Message) => {
        selected.push(message)
        throw stopped
      }
    }) as Scenarios
    const error = await captureFailure(scenario.I2())
    return { selected, target, error, stopped }
  }

  for (const surface of ['web-wide', 'web-narrow', 'ios', 'android'])
    it('replies to the prepared legacy peer post on ' + surface, async () => {
      const actual = await selection(surface)
      expect(actual.error).equals(actual.stopped)
      expect(actual.selected).deep.equals([actual.target])
    })

  it('refuses a prepared target authored by another account before opening Reply', async () => {
    const actual = await selection('android', true)
    expect(String(actual.error)).includes(
      'Prepared legacy peer reply target required'
    )
    expect(actual.selected).deep.equals([])
  })
})

describe('native scenario navigation and mention handoff', function () {
  this.timeout(10000)
  const member = {
    userId: userIdOfGumbo(5),
    name: 'Aaron Judge',
    role: 'Coach',
    search: 'Aaron'
  }
  const freshId = 'usr_11112LJ7YLqvVc8DmhwPNw'
  const target: Chat2Message = {
    id: 'msg-legacy-peer',
    seq: 231,
    body: 'Bring water.',
    authorId: member.userId
  }
  const directories: string[] = []
  afterEach(() => {
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true })
  })

  function nativeReader(
    mode:
      | 'above'
      | 'below'
      | 'keyboard'
      | 'stuck'
      | 'fling'
      | 'pin'
      | 'overshoot'
      | 'closed-stuck'
      | 'edge-damped'
      | 'edge-cross'
      | 'edge-stuck'
      | 'edge-wrong'
      | 'edge-repeat',
    surface = 'android',
    selected = target
  ): { scenario: Scenarios; calls: unknown[] } {
    const calls: unknown[] = []
    const edge = mode.startsWith('edge-')
    const closedFile = mode === 'overshoot' || mode === 'closed-stuck' || edge
    let closedMoves = 0
    let keyboard = mode === 'keyboard' || mode === 'stuck'
    let rect =
      mode === 'above'
        ? { x: 20, y: 0, width: 180, height: -1200 }
        : mode === 'fling'
          ? { x: 20, y: 95, width: 180, height: 80 }
          : { x: 20, y: 2200, width: 180, height: -1200 }
    if (surface === 'ios' && mode === 'above')
      rect = {
        x: 48,
        y: -8756.33349609375,
        width: 281.3333435058594,
        height: 96.6669921875
      }
    if (closedFile) rect = { x: 126, y: 0, width: 672, height: -22280 }
    if (edge) rect = { x: 126, y: 0, width: 755, height: -25723 }
    const band = (): { top: number; bottom: number } => ({
      top: closedFile ? 432 : surface === 'ios' ? 109.3333346247673 : 100,
      bottom: closedFile
        ? 1929
        : surface === 'ios'
          ? keyboard
            ? 462
            : 700.6666870117188
          : keyboard
            ? 500
            : 900
    })
    const nodes = (): PublicNode[] => [
      {
        id: 'chat-message-history',
        bounds: {
          x: 0,
          y: 0,
          width: closedFile ? 1080 : 400,
          height: closedFile ? 2400 : 1000
        }
      },
      {
        id: 'chat-conversation-identity',
        bounds:
          surface === 'ios'
            ? { x: 64, y: 62.3333346247673, width: 274, height: 47 }
            : { x: 0, y: 40, width: 400, height: closedFile ? 392 : 60 }
      },
      {
        id: 'chat-composer-band',
        bounds: { x: 0, y: band().bottom, width: 400, height: 60 }
      },
      {
        id: 'chat-composer',
        type: surface === 'ios' ? 'TextView' : 'EditText',
        focused: keyboard,
        bounds: { x: 50, y: band().bottom + 5, width: 200, height: 40 }
      },
      { id: 'chat-bubble-' + selected.id, bounds: { ...rect } },
      ...(surface === 'ios' && keyboard
        ? [
            {
              type: 'Keyboard',
              bounds: { x: 0, y: 600, width: 400, height: 400 }
            }
          ]
        : [])
    ]
    const actual = Object.assign(Object.create(Chat2UI.prototype), {
      native: true,
      deadline: AbortSignal.timeout(10000),
      surface,
      steps: [],
      device: {
        hierarchy: async () =>
          surface === 'ios'
            ? {
                nodes: nodes().map((node, index) => ({
                  index,
                  type: node.type ?? 'Other',
                  identifier: node.id,
                  label: node.text,
                  rect: node.bounds,
                  enabled: true,
                  hittable: false
                }))
              }
            : nodes(),
        platformInfo: async () => ({
          screenWidth: closedFile ? 1080 : 400,
          screenHeight: closedFile ? 2400 : 1000
        }),
        scrollUntilVisible: async (args: Record<string, unknown>) => {
          if (keyboard) throw Error('Global gesture starts in actual Keyboard')
          calls.push(args)
          if (closedFile) {
            rect = { x: 126, y: 24087, width: 672, height: -21687 }
            throw Error('Element not found after 40 fixed-direction scrolls')
          }
          expect(args.direction).equals(mode === 'above' ? 'UP' : 'DOWN')
          rect = { x: 20, y: 250, width: 180, height: 80 }
        },
        swipe: async (args: Record<string, unknown>) => {
          if (surface === 'ios')
            throw Error('iOS swipe leaves movement duration uncontrolled')
          const b = band()
          const start = Number(args.startY)
          const end = Number(args.endY)
          expect(Math.min(start, end)).greaterThan(b.top)
          expect(Math.max(start, end)).lessThan(b.bottom)
          calls.push(args)
          if (edge) {
            closedMoves++
            if (closedMoves === 1)
              rect = { x: 126, y: 0, width: 755, height: 432 }
            else if (mode === 'edge-stuck') {
              /* Actual target does not move. */
            } else if (mode === 'edge-wrong')
              rect = { x: 126, y: 0, width: 755, height: 300 }
            else if (closedMoves === 2 && mode !== 'edge-damped')
              rect = { x: 126, y: 2114, width: 755, height: 286 }
            else if (mode === 'edge-repeat')
              rect = { x: 126, y: 0, width: 755, height: 432 }
            else {
              // The observed 899px gesture moved this target by 2114px.
              const origin = closedMoves === 2 ? 0 : rect.y
              rect = {
                x: 126,
                y: Math.round(origin + ((end - start) * 2114) / 899),
                width: 755,
                height: 286
              }
            }
          } else if (closedFile) {
            closedMoves++
            if (mode !== 'closed-stuck')
              rect =
                closedMoves === 1
                  ? { x: 126, y: 24087, width: 672, height: -21687 }
                  : { x: 126, y: 700, width: 672, height: 719 }
          } else if (mode !== 'stuck')
            rect =
              mode === 'fling'
                ? { ...rect, y: rect.y + (end - start) * 2 }
                : { x: 20, y: 250, width: 180, height: 80 }
        },
        dragAndDrop: async (
          args: Record<string, unknown>,
          options?: { signal: AbortSignal }
        ) => {
          expect(surface).equals('ios')
          expect(args.holdDuration).equals(16)
          expect(args.duration).equals(200)
          expect(options?.signal).instanceOf(AbortSignal)
          expect(options?.signal.aborted).equals(false)
          const from = args.from as { point: string }
          const to = args.to as { point: string }
          const start = from.point.split(',').map(Number)
          const end = to.point.split(',').map(Number)
          expect(start).has.length(2)
          expect(end).has.length(2)
          expect(start[0]).equals(end[0])
          const b = band()
          expect(Math.min(start[1], end[1])).greaterThan(b.top)
          expect(Math.max(start[1], end[1])).lessThan(b.bottom)
          calls.push(args)
          rect = { ...rect, y: rect.y + (end[1] - start[1]) * 1.7 }
        },
        assertVisible: async () => ({}),
        longPressOn: async () => {
          const b = band()
          if (
            rect.height <= 0 ||
            rect.y < b.top + 7.5 ||
            rect.y + rect.height > b.bottom - 7.5
          )
            throw Error('Actual hold target is clipped or occluded')
          calls.push('hold')
        },
        tapOn: async (args: Record<string, unknown>) => {
          calls.push(args)
          if (args.id === 'chat-pin-' + selected.id)
            rect = { x: 20, y: 250, width: 180, height: 80 }
          if (args.text === '^Reply$') keyboard = true
        }
      },
      visible: async (args: Record<string, unknown>) =>
        args.id === 'chat-pinned-summary' ? mode === 'pin' : true,
      readAndroidIme: async () => ({
        bounds: { x: 0, y: 600, width: 400, height: 400 }
      }),
      assertKeyboard: async () => {
        expect(keyboard).equals(true)
        calls.push('reply-keyboard')
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: selected } },
      observations: []
    }) as Scenarios
    return { scenario, calls }
  }

  for (const mode of ['above', 'below', 'keyboard', 'fling', 'pin'] as const)
    it(
      'requires actual native framing before ordinary Reply: ' + mode,
      async () => {
        const model = nativeReader(mode)
        await model.scenario.reply(target)
        expect(model.calls).includes('hold')
        expect(model.calls.at(-1)).equals('reply-keyboard')
        if (mode === 'pin')
          expect(model.calls).deep.includes({ id: 'chat-pin-' + target.id })
      }
    )
  it('reads fractional iOS geometry and reaches the exact distant Reply target through explicitly timed drags', async () => {
    const model = nativeReader('above', 'ios')
    const observed = (await model.scenario.ui.nodes()).find(
      node => node.id === 'chat-bubble-' + target.id
    )
    expect(observed?.bounds).deep.equals({
      x: 48,
      y: -8756.33349609375,
      width: 281.3333435058594,
      height: 96.6669921875
    })
    await model.scenario.reply(target)
    expect(model.calls).includes('hold')
    expect(
      model.calls.filter(
        call => typeof call === 'object' && call != null && 'from' in call
      ).length
    ).greaterThan(1)
    expect(
      model.calls.some(
        call => typeof call === 'object' && call != null && 'direction' in call
      )
    ).equals(false)
  })
  it('rejects a keyboard-band gesture with no real reader progress before any hold', async () => {
    const model = nativeReader('stuck')
    expect(String(await captureFailure(model.scenario.reply(target)))).includes(
      'advance'
    )
    expect(model.calls).not.includes('hold')
  })

  it('reverses a closed Android reader after the exact clipped file overshoots from above to below', async () => {
    const file = {
      ...target,
      id: 'msg-preserved-file',
      seq: 239,
      body: 'Synthetic encrypted file post'
    }
    const model = nativeReader('overshoot', 'android', file)
    await model.scenario.anchor(file)
    const proofs = model.scenario.observations.filter(
      row => row.nativeAnchor === file.id
    )
    expect(proofs).has.length(1)
    const proof = proofs[0]
    const gestures = proof.gestures as Array<{ startY: number; endY: number }>
    expect(gestures).has.length(2)
    expect(gestures[0].endY).greaterThan(gestures[0].startY)
    expect(gestures[1].endY).lessThan(gestures[1].startY)
    const samples = proof.samples as Array<{
      box: { y: number; height: number }
    }>
    expect(samples.map(row => [row.box.y, row.box.height])).deep.equals([
      [0, -22280],
      [24087, -21687],
      [700, 719]
    ])
    expect(proof.outcome).equals('passed')
    expect(
      model.calls.some(
        call => typeof call === 'object' && call != null && 'direction' in call
      )
    ).equals(false)
  })
  it('rejects a closed clipped Android reader with no measured progress before any hold', async () => {
    const model = nativeReader('closed-stuck')
    expect(
      String(await captureFailure(model.scenario.anchor(target)))
    ).includes('Exact target must advance')
    expect(model.calls).not.includes('hold')
    expect(model.scenario.observations[0].outcome).not.equals('passed')
  })

  for (const mode of ['edge-damped', 'edge-cross'] as const)
    it(
      'damps the actual closed Android zero-gap edge and frames the same reply: ' +
        mode,
      async () => {
        const reply = { ...target, id: 'msg-preserved-reply', seq: 237 }
        const m = nativeReader(mode, 'android', reply)
        await m.scenario.anchor(reply)
        const proof = m.scenario.observations.find(
          p => p.nativeAnchor === reply.id
        )!
        const samples = proof.samples as Array<{
          box: { y: number; height: number }
          band: { top: number; bottom: number }
        }>
        const gestures = proof.gestures as Array<{
          startY: number
          endY: number
        }>
        expect(
          samples.slice(0, 2).map(p => [p.box.y, p.box.height])
        ).deep.equals([
          [0, -25723],
          [0, 432]
        ])
        expect(Math.abs(gestures[1].endY - gestures[1].startY)).lessThan(
          Math.abs(gestures[0].endY - gestures[0].startY)
        )
        if (mode === 'edge-cross') {
          expect(samples[2].box).includes({ y: 2114, height: 286 })
          expect(gestures[2].endY).lessThan(gestures[2].startY)
          expect(Math.abs(gestures[2].endY - gestures[2].startY)).lessThan(
            Math.abs(gestures[1].endY - gestures[1].startY)
          )
          expect(proof.nativeAnchorReversal).not.equals(undefined)
        }
        const final = samples.at(-1)!
        expect(final.box.height).greaterThan(0)
        expect(final.box.y).at.least(final.band.top + 7.5)
        expect(final.box.y + final.box.height).at.most(final.band.bottom - 7.5)
        expect(proof.outcome).equals('passed')
      }
    )

  for (const mode of ['edge-stuck', 'edge-wrong', 'edge-repeat'] as const)
    it(
      'rejects unproved closed Android movement without a hold: ' + mode,
      async () => {
        const m = nativeReader(mode)
        const error = String(await captureFailure(m.scenario.anchor(target)))
        expect(error).includes(
          mode === 'edge-repeat'
            ? 'Only one target crossing'
            : 'Exact target must advance'
        )
        expect(m.calls).not.includes('hold')
        expect(m.scenario.observations[0].outcome).not.equals('passed')
      }
    )

  function mentionBoundary(
    surface: 'ios' | 'android',
    fault = ''
  ): {
    scenario: Scenarios
    ui: Chat2UI
    calls: string[]
    stopped: Error
    setAdvance: (work: (ms: number) => void) => void
  } {
    const calls: string[] = []
    let phase = 'conversation'
    let value = ''
    let query = ''
    let closingReads = 0
    let appended = false
    let advance = (_ms: number): void => {}
    const path = mkdtempSync(join(tmpdir(), 'chat-mention-boundary-'))
    directories.push(path)
    const nodes = (): PublicNode[] => {
      if (phase === 'closing') {
        closingReads++
        if (closingReads >= 3 && fault !== 'never-ready') {
          phase = 'ready'
          value = fault === 'wrong-value' ? '@AaronJudge ' : '@Aaron Judge '
        }
        if (fault === 'never-ready' || fault === 'wrong-value') advance(4000)
      }
      const picker =
        phase === 'picker' ||
        phase === 'closing' ||
        (fault === 'stale-picker' && phase === 'ready')
      const result: PublicNode[] =
        fault === 'missing-keyboard' && phase === 'ready'
          ? []
          : [
              {
                type: 'Keyboard',
                bounds: { x: 0, y: 600, width: 400, height: 400 }
              }
            ]
      if (phase !== 'closing')
        result.push({
          id: 'chat-composer',
          type: surface === 'ios' ? 'TextView' : 'EditText',
          text: value,
          focused: phase === 'ready',
          enabled: true,
          bounds: { x: 50, y: 510, width: 250, height: 40 }
        })
      if (picker)
        result.push(
          {
            id: 'chat-picker-scene',
            bounds: { x: 0, y: 0, width: 400, height: 1000 }
          },
          {
            id: 'chat-picker-header',
            bounds: { x: 0, y: 0, width: 400, height: 100 }
          },
          {
            type: surface === 'ios' ? 'TextField' : 'EditText',
            text: query !== '' ? query : 'Search members',
            focused: true,
            enabled: true,
            bounds: { x: 20, y: 140, width: 360, height: 40 }
          },
          {
            id: 'chat-mention-member-' + member.userId,
            type: 'Button',
            text:
              member.name +
              ', ' +
              (fault === 'wrong-role' ? 'Member' : member.role),
            bounds: {
              x: 20,
              y:
                fault === 'closed-outside'
                  ? 1020
                  : fault === 'header-occluded'
                    ? 20
                    : query === member.name
                      ? 260
                      : 700,
              width: 360,
              height: 60
            }
          }
        )
      if (
        (fault === 'stale-picker' || fault === 'missing-keyboard') &&
        phase === 'ready'
      )
        advance(4000)
      return result
    }
    const raw = (): Buffer =>
      Buffer.from(
        JSON.stringify({
          nodes: nodes().map((node, index) => ({
            index,
            type: node.type ?? 'Other',
            identifier: node.id,
            label:
              node.type === 'TextView'
                ? 'Message Message'
                : node.type === 'TextField'
                  ? 'Search members'
                  : node.text,
            value:
              node.type === 'TextField'
                ? query !== ''
                  ? query
                  : undefined
                : node.type === 'TextView'
                  ? node.text?.trim()
                  : undefined,
            enabled: node.enabled ?? true,
            rect: node.bounds
          }))
        })
      )
    const imeRaw = (): string => {
      if (fault === 'malformed-ime') return 'InputMethod state unavailable'
      const closed =
        ((fault === 'closed-before' || fault === 'closed-outside') &&
          phase === 'picker') ||
        (fault === 'closed-after' && phase === 'ready')
      return (
        'Window #0 Window{0000 u0 InputMethod}\n' +
        ' isOnScreen=' +
        String(!closed) +
        '\n' +
        ' mHasSurface=' +
        String(!closed) +
        '\n' +
        ' touchable region=SkRegion((0,600,400,1000))'
      )
    }
    const actual = Object.assign(Object.create(Chat2UI.prototype), {
      surface,
      deadline: AbortSignal.timeout(10000),
      native: true,
      steps: [],
      runDir: path,
      fixture: { members: [member] },
      device: {
        hierarchy: async () => nodes(),
        hierarchyRaw: async () => raw(),
        inputText: async (args: Record<string, unknown>) => {
          const text = String(args.text)
          if (text === '@') {
            phase = 'picker'
            value = '@'
            calls.push('trigger')
            if (surface === 'ios' && args.id !== 'chat-composer')
              throw Error(
                'Unchanged unrelated settings-pill-button verification'
              )
          } else if (phase === 'picker' && text === member.name) {
            query = text
            calls.push('search')
          } else {
            if (phase !== 'ready')
              throw Error('Append began before real selection handoff')
            if (surface === 'ios' && args.id !== 'chat-composer')
              throw Error('Input reused disappearing member-row coordinates')
            value += text
            appended = true
            calls.push('append')
          }
        },
        tapOn: async (args: Record<string, unknown>) => {
          if (args.text === '^Search members$') {
            calls.push('search-control')
            return
          }
          if (args.id === 'chat-mention-member-' + member.userId) {
            calls.push('member')
            if (query === member.name || fault === 'closed-before')
              phase = 'closing'
          }
        },
        assertVisible: async () => ({}),
        copyTextFrom: async () => ({ data: value })
      },
      readAndroidIme: async () => ({
        bounds: androidImeFrame(imeRaw(), { width: 400, height: 1000 })
      }),
      observeAndroidIme: async () => {
        const viewport = { width: 400, height: 1000 }
        const state = androidCaptureImeState(imeRaw(), viewport)
        calls.push('preselection-ime-' + state.state)
        return { state, bounds: state.keyboard, viewport }
      }
    }) as Chat2UI
    const stopped = Error('Actual I2 append boundary reached')
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerKey: 'Fresh',
      viewerId: freshId,
      group: 'cg-fixture',
      observations: [],
      f: {
        members: [member],
        identityCompatibility: { fullWidthActors: ['Fresh'] },
        actors: { Fresh: { provider: {} } },
        messages: { target }
      },
      check: async (_label: string, work: () => Promise<void>) => {
        await work()
      },
      client: async () => ({
        whoAmI: async () => ({ gumboId: null }),
        myChatKeys: async () => ({ identity: {} })
      }),
      signIn: async () => {},
      openGroup: async () => {},
      reply: async () => {
        calls.push('reply-keyboard-already-proved')
      },
      protocolPeer: async () => ({
        client: { whoAmI: async () => ({ id: member.userId }) }
      }),
      attachPhoto: async () => {
        expect(appended).equals(true)
        expect(value).matches(/^@Aaron Judge {2}mixed identity \d+$/)
        throw stopped
      }
    }) as Scenarios
    return {
      scenario,
      ui: actual,
      calls,
      stopped,
      setAdvance: work => {
        advance = work
      }
    }
  }

  for (const surface of ['ios', 'android'] as const)
    it(
      'runs actual I2 through clear exact member selection and completed handoff on ' +
        surface,
      async () => {
        const model = mentionBoundary(surface)
        expect(await captureFailure(model.scenario.I2())).equals(model.stopped)
        expect(
          model.calls.filter(call => !call.startsWith('preselection-ime-'))
        ).deep.equals([
          'reply-keyboard-already-proved',
          'trigger',
          'search-control',
          'search',
          'member',
          'append'
        ])
        expect(
          model.ui.steps.some(
            step =>
              step.name === 'Observed native member selection' &&
              step.outcome === 'passed'
          )
        ).equals(true)
      }
    )
  it('selects the exact visible Android member with an explicitly closed preselection IME and requires the fresh open composer', async () => {
    const model = mentionBoundary('android', 'closed-before')
    expect(await captureFailure(model.scenario.I2())).equals(model.stopped)
    expect(model.calls).includes('member')
    expect(model.calls).includes('append')
    expect(model.calls).not.includes('search')
    expect(model.calls).includes('preselection-ime-already-closed')
  })
  it('rejects an Android IME that closes after exact member selection before appending', async () => {
    const model = mentionBoundary('android', 'closed-after')
    expect(String(await captureFailure(model.scenario.I2()))).includes(
      'Hidden, conflicting or unknown Android IME visibility'
    )
    expect(model.calls).includes('member')
    expect(model.calls).not.includes('append')
  })
  for (const fault of ['closed-outside', 'header-occluded'])
    it(
      'rejects an Android member outside the observed clear bounds: ' + fault,
      async () => {
        const model = mentionBoundary('android', fault)
        expect(String(await captureFailure(model.scenario.I2()))).includes(
          'Exact member row must clear header'
        )
        expect(model.calls).not.includes('member')
        expect(model.calls).not.includes('append')
      }
    )
  it('rejects malformed Android IME evidence before selecting any member', async () => {
    const model = mentionBoundary('android', 'malformed-ime')
    expect(String(await captureFailure(model.scenario.I2()))).includes(
      'One actual InputMethod window required'
    )
    expect(model.calls).not.includes('member')
    expect(model.calls).not.includes('append')
  })
  it('keeps generic iOS Search typing on the focused field rather than the composer', async () => {
    const model = mentionBoundary('ios')
    await model.ui.typeMentionTrigger()
    await model.ui.text('Search members')
    await model.ui.append(member.name)
    expect(model.calls.at(-1)).equals('search')
  })
  for (const fault of [
    'never-ready',
    'wrong-value',
    'stale-picker',
    'missing-keyboard'
  ])
    it(
      'refuses to append when the native handoff is unproved: ' + fault,
      async () => {
        const model = mentionBoundary(
          fault === 'wrong-value' || fault === 'missing-keyboard'
            ? 'ios'
            : 'android',
          fault
        )
        const clock = Date.now
        let offset = 0
        Date.now = () => clock() + offset
        model.setAdvance(ms => {
          offset += ms
        })
        try {
          expect(String(await captureFailure(model.scenario.I2()))).includes(
            'Timed out waiting for selected exact member'
          )
          expect(model.calls).not.includes('append')
        } finally {
          Date.now = clock
        }
      }
    )
  it('rejects a same-name member with the wrong visible role before selection', async () => {
    const model = mentionBoundary('android', 'wrong-role')
    expect(String(await captureFailure(model.scenario.I2()))).includes(
      'Exact member name and role'
    )
    expect(model.calls).not.includes('member')
    expect(model.calls).not.includes('append')
  })
  it('uses the ordinary latest chevron before anchoring the new authenticated incoming file', async () => {
    const path = mkdtempSync(join(tmpdir(), 'chat-incoming-boundary-'))
    directories.push(path)
    const photo = join(path, 'synthetic.png')
    writeFileSync(photo, captureImages[0])
    const calls: string[] = []
    const stopped = Error('Exact incoming anchor boundary reached')
    const identity = { id: 'cid-synthetic' }
    let value = ''
    const incoming = {
      id: 'msg-mixed-incoming',
      seq: 240,
      body: 'Mixed incoming identity 123'
    }
    const peer = {
      client: { whoAmI: async () => ({ id: member.userId }) },
      engine: { fillGrants: async () => {}, attach: async () => incoming }
    }
    const own = { rotateUserKey: async () => 2 }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      viewerKey: 'Fresh',
      viewerId: freshId,
      group: 'cg-fixture',
      observations: [],
      f: {
        members: [member],
        files: { photo },
        identityCompatibility: { fullWidthActors: ['Fresh'] },
        actors: { Fresh: { provider: {} } },
        messages: { target }
      },
      ui: {
        surface: 'android',
        typeMentionTrigger: async () => {},
        selectMention: async () => {
          value = '@Aaron Judge '
        },
        appendComposer: async (text: string) => {
          value += text
        },
        append: async (text: string) => {
          value += text
        },
        draft: async () => value,
        text: async () => {},
        id: async (id: string) => {
          calls.push(id)
        }
      },
      check: async (_label: string, work: () => Promise<void>) => {
        await work()
      },
      client: async () => ({
        whoAmI: async () => ({ gumboId: null }),
        myChatKeys: async () => ({ identity }),
        chatDevices: async () => [
          { id: 'cd-app', linked: true },
          { id: 'cd-peer', linked: true }
        ]
      }),
      signIn: async () => {},
      openGroup: async () => {
        calls.push('open')
      },
      reply: async () => {},
      attachPhoto: async () => {},
      protocolPeer: async (key?: string) => (key === 'Fresh' ? own : peer),
      delivered: async () => ({
        id: 'msg-sent',
        senderUserId: freshId,
        mentions: [member.userId],
        quote: { id: target.id, authorId: target.authorId },
        attachments: [{}]
      }),
      anchor: async (message: Chat2Message) => {
        expect(message.id).equals(incoming.id)
        expect(calls.at(-1)).equals('chat-jump-latest')
        throw stopped
      }
    }) as Scenarios
    expect(await captureFailure(scenario.I2())).equals(stopped)
    expect(calls).deep.equals(['open', 'open', 'chat-jump-latest'])
  })
})

describe('iOS spotlight backdrop dismissal', () => {
  function model(
    top: number,
    fault = ''
  ): {
    scenario: Scenarios
    calls: string[]
    actions: string[]
    pinned: () => boolean
  } {
    const calls: string[] = []
    const actions: string[] = []
    let open = true
    let pinned = true
    const controls = {
      x: 8,
      y: top,
      width: 386,
      height: fault === 'compact' ? 48 : 360
    }
    const frame = { x: 0, y: 0, width: 402, height: 874 }
    const nodes = (): PublicNode[] =>
      fault === 'generic'
        ? []
        : [
            { id: 'chat-message-spotlight', bounds: frame },
            ...(fault === 'missing-controls'
              ? []
              : [
                  {
                    id: 'chat-message-spotlight-controls',
                    bounds: fault === 'covered' ? frame : controls
                  }
                ]),
            ...(fault === 'compact'
              ? []
              : [
                  {
                    id: 'chat-message-spotlight-preview',
                    bounds: {
                      x: 8,
                      y: top + 56,
                      width: 281.3333435058594,
                      height: 128
                    }
                  }
                ]),
            ...(fault === 'compact'
              ? []
              : [
                  {
                    id: 'chat-message-spotlight-panel',
                    bounds: { x: 8, y: top + 192, width: 386, height: 168 }
                  }
                ])
          ]
    const tap = (x: number, y: number): void => {
      calls.push('tap')
      if (
        x >= controls.x &&
        x <= controls.x + controls.width &&
        y >= controls.y &&
        y <= controls.y + controls.height
      ) {
        if (y >= top + 305 && y <= top + 353) {
          actions.push('Unpin')
          pinned = false
          open = false
        }
        return
      }
      open = false
    }
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native: true,
      surface: fault === 'android' ? 'android' : 'ios',
      deadline: AbortSignal.timeout(10000),
      device: {
        hierarchy: async () => ({
          nodes: nodes().map((n, index) => ({
            index,
            type: 'Other',
            identifier: n.id,
            rect: n.bounds
          }))
        }),
        assertVisible: async () => ({}),
        assertNotVisible: async () => {
          expect(open, 'unchanged strict spotlight absence oracle').equals(
            false
          )
        },
        tapOn: async () => {
          if (fault === 'generic') {
            calls.push('Cancel')
            open = false
          } else tap(frame.width / 2, frame.height / 2)
        },
        tapOnPoint: async ({ x, y }: { x: number; y: number }) => {
          tap(x, y)
        },
        back: async () => {
          calls.push('Back')
          open = false
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      observations: []
    }) as Scenarios
    return { scenario, calls, actions, pinned: () => pinned }
  }

  for (const [name, top] of [
    ['Unpin', 122.66666412353516],
    ['reaction', 434.3333435058594]
  ] as const)
    it(
      'dismisses from measured exposed backdrop when the fullscreen Cancel center overlaps ' +
        name,
      async () => {
        const m = model(top)
        await m.scenario.dismiss()
        await m.scenario.ui.absent('chat-message-spotlight')
        expect(m.calls).deep.equals(['tap'])
        expect(m.actions).deep.equals([])
        expect(m.pinned()).equals(true)
        expect(m.scenario.observations).has.length(1)
      }
    )

  for (const fault of ['covered', 'missing-controls'])
    it(
      'fails before a tap without proven exposed geometry: ' + fault,
      async () => {
        const m = model(122.66666412353516, fault)
        expect(await captureFailure(m.scenario.dismiss())).instanceOf(Error)
        expect(m.calls).deep.equals([])
        expect(m.actions).deep.equals([])
        expect(m.pinned()).equals(true)
      }
    )

  it('dismisses compact spotlight when only the measured controls remain', async () => {
    const m = model(122.66666412353516, 'compact')
    await m.scenario.dismiss()
    await m.scenario.ui.absent('chat-message-spotlight')
    expect(m.actions).deep.equals([])
    expect(m.pinned()).equals(true)
  })

  it('retains an ordinary iOS Cancel outside spotlight', async () => {
    const m = model(0, 'generic')
    await m.scenario.dismiss()
    expect(m.calls).deep.equals(['Cancel'])
  })
  it('retains Android Back without an iOS backdrop tap', async () => {
    const m = model(0, 'android')
    await m.scenario.dismiss()
    expect(m.calls).deep.equals(['Back'])
  })
})

describe('native absent history paging', function () {
  this.timeout(15000)
  const target: Chat2Message = {
    id: 'msg-preserved-outgoing',
    seq: 5,
    body: 'Practice update: bring water.',
    authorId: userIdOfGumbo(5)
  }

  function model(
    fault = '',
    surface: 'ios' | 'android' = 'ios'
  ): {
    scenario: Scenarios
    taps: Array<{ x: number; y: number }>
    gestures: unknown[]
  } {
    const taps: Array<{ x: number; y: number }> = []
    const gestures: unknown[] = []
    let pages = 0
    let earlierY =
      surface === 'android' || fault === 'no-progress' || fault === 'limit'
        ? 300
        : -4395.33332824707
    let targetY = fault === 'loaded' ? -500 : 300
    const loaded = (): boolean =>
      fault === 'loaded' || (fault !== 'limit' && pages === 2)
    const nodes = (): PublicNode[] => [
      {
        id: 'chat-message-history',
        type: 'Other',
        text: 'Load earlier messages',
        bounds: { x: 0, y: 0, width: 402, height: 874 }
      },
      {
        id: 'chat-conversation-identity',
        type: 'Button',
        bounds: { x: 64, y: 62.3333346247673, width: 274, height: 47 }
      },
      {
        id: 'chat-pinned-band',
        bounds: { x: 16, y: 110, width: 370, height: 60.66667175292969 }
      },
      {
        id: 'chat-composer-band',
        bounds: { x: 16, y: 700.6666870117188, width: 370, height: 54 }
      },
      { type: 'ScrollView', text: 'Load earlier messages' },
      { type: 'Other', text: 'Load earlier messages' },
      ...(fault === 'exhausted'
        ? []
        : Array.from({ length: fault === 'duplicate' ? 2 : 1 }, () => ({
            id: 'settings-pill-button',
            type: 'Button',
            text: 'Load earlier messages',
            enabled:
              fault === 'omitted-enabled' ? undefined : fault !== 'disabled',
            bounds: { x: 16, y: earlierY, width: 370, height: 48 }
          }))),
      {
        id: 'chat-bubble-msg-recent',
        bounds: { x: 48, y: 400, width: 281, height: 96 }
      },
      ...(pages > 0
        ? [
            {
              id: 'chat-bubble-msg-older-page-' + pages,
              bounds: { x: 48, y: 500, width: 281, height: 96 }
            }
          ]
        : []),
      ...(loaded()
        ? [
            {
              id: 'chat-bubble-' + target.id,
              bounds: {
                x: 48,
                y: targetY,
                width: 281.3333435058594,
                height: 96.6669921875
              }
            }
          ]
        : [])
    ]
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native: true,
      surface,
      deadline: AbortSignal.timeout(fault === 'no-progress' ? 600 : 15000),
      steps: [],
      visible: async () => false,
      device: {
        platformInfo: async () => ({ screenWidth: 402, screenHeight: 874 }),
        // Preserve the actual flat XCTest snapshot contract, including duplicate ancestor labels.
        hierarchy: async (options?: { signal: AbortSignal }) => {
          options?.signal.throwIfAborted()
          if (surface === 'android')
            return { type: 'FrameLayout', children: nodes() }
          return {
            nodes: nodes().map((node, index) => ({
              index,
              type: node.type ?? 'Other',
              identifier: node.id,
              label: node.text,
              rect: node.bounds,
              enabled: node.enabled,
              hittable: false
            }))
          }
        },
        dragAndDrop: async (args: {
          from: { point: string }
          to: { point: string }
          holdDuration: number
          duration: number
        }) => {
          expect(args.holdDuration).equals(16)
          expect(args.duration).equals(200)
          const start = args.from.point.split(',').map(Number)
          const end = args.to.point.split(',').map(Number)
          expect(Math.min(start[1], end[1])).greaterThan(170.6666717529297)
          expect(Math.max(start[1], end[1])).lessThan(700.6666870117188)
          gestures.push(args)
          if (fault !== 'stuck') {
            const delta = (end[1] - start[1]) * 1.7
            if (loaded()) targetY += delta
            else earlierY += delta
          }
        },
        tapOnPoint: async (
          point: { x: number; y: number },
          options?: { signal: AbortSignal }
        ) => {
          options?.signal.throwIfAborted()
          expect(point.x).equals(201)
          expect(point.y).equals(earlierY + 24)
          expect(point.y - 24).at.least(178.1666717529297)
          expect(point.y + 24).at.most(693.1666870117188)
          taps.push(point)
          if (fault !== 'no-progress') pages++
        },
        assertVisible: async (selector: { id: string }) => {
          expect(selector.id).equals('chat-bubble-' + target.id)
          expect(loaded()).equals(true)
          expect(targetY).at.least(178.1666717529297)
          expect(targetY + 96.6669921875).at.most(693.1666870117188)
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      f: { messages: { target } },
      observations: []
    }) as Scenarios
    return { scenario, taps, gestures }
  }

  it('honors omitted enabled metadata on the normalized Android earlier Button before and after framing', async () => {
    const m = model('omitted-enabled', 'android')
    const before = await m.scenario.ui.nodes()
    const control = before.find(
      node => node.type === 'Button' && node.text === 'Load earlier messages'
    )!
    expect(control.enabled).equals(undefined)
    await m.scenario.nativeHistoryTarget(target)
    expect(m.taps).has.length(2)
    const paging = m.scenario.observations.find(
      row => row.nativeHistoryTarget === target.id
    )!
    expect(paging.outcome).equals('passed')
    expect(paging.pages).has.length(2)
    expect(m.gestures).deep.equals([])
  })

  it('rejects explicit disabled metadata on the normalized Android earlier Button', async () => {
    const m = model('disabled', 'android')
    expect(
      String(await captureFailure(m.scenario.nativeHistoryTarget(target)))
    ).includes('Enabled public native earlier Button required')
    expect(m.taps).deep.equals([])
  })

  it('requires explicit enabled metadata on the raw iOS earlier Button', async () => {
    const m = model('omitted-enabled')
    const before = await m.scenario.ui.nodes()
    expect(
      before.find(
        node => node.type === 'Button' && node.text === 'Load earlier messages'
      )?.enabled
    ).equals(undefined)
    expect(
      String(await captureFailure(m.scenario.nativeHistoryTarget(target)))
    ).includes('Enabled public native earlier Button required')
    expect(m.taps).deep.equals([])
  })

  it('loads the absent exact original through two real earlier-page Buttons before target framing', async () => {
    const m = model()
    const before = await m.scenario.ui.nodes()
    expect(
      before.filter(node => node.text === 'Load earlier messages')
    ).has.length(4)
    expect(
      before.find(
        node => node.type === 'Button' && node.text === 'Load earlier messages'
      )?.bounds
    ).includes({ y: -4395.33332824707, height: 48 })
    expect(before.some(node => node.id === 'chat-bubble-' + target.id)).equals(
      false
    )
    await m.scenario.anchor(target)
    expect(m.taps).has.length(2)
    expect(m.gestures.length).greaterThan(1)
    const paging = m.scenario.observations.find(
      row => row.nativeHistoryTarget === target.id
    )!
    expect(paging.outcome).equals('passed')
    expect(paging.pages).has.length(2)
    const controls = m.scenario.observations.filter(
      row => row.nativeEarlierControlFor === target.id
    )
    expect(controls).has.length(2)
    expect(controls.every(row => row.nativeAnchor === undefined)).equals(true)
    const anchors = m.scenario.observations.filter(
      row => row.nativeAnchor === target.id
    )
    expect(anchors).has.length(1)
    expect(anchors[0].outcome).equals('passed')
    expect(target.seq).equals(5)
  })

  it('keeps an already loaded clipped exact target on the existing measured path without paging', async () => {
    const m = model('loaded')
    await m.scenario.anchor(target)
    expect(m.taps).deep.equals([])
    expect(m.gestures.length).greaterThan(0)
    expect(
      m.scenario.observations.some(
        row =>
          row.nativeHistoryTarget != null || row.nativeEarlierControlFor != null
      )
    ).equals(false)
    expect(
      m.scenario.observations.find(row => row.nativeAnchor === target.id)
        ?.outcome
    ).equals('passed')
  })

  it('stops after ten progressing public pages without claiming the missing original', async () => {
    const m = model('limit')
    expect(String(await captureFailure(m.scenario.anchor(target)))).includes(
      'Bounded native earlier-page count required'
    )
    expect(m.taps).has.length(10)
    expect(
      m.scenario.observations.some(row => row.nativeAnchor === target.id)
    ).equals(false)
    expect(
      m.scenario.observations.find(row => row.nativeHistoryTarget === target.id)
        ?.outcome
    ).not.equals('passed')
  })

  for (const fault of [
    'exhausted',
    'duplicate',
    'disabled',
    'stuck',
    'no-progress'
  ])
    it(
      'refuses absent history without proved public page progress: ' + fault,
      async () => {
        const m = model(fault)
        const error = String(await captureFailure(m.scenario.anchor(target)))
        expect(error).matches(
          fault === 'stuck'
            ? /advance/
            : fault === 'no-progress'
              ? /Timeout|abort/i
              : /earlier Button/
        )
        expect(
          m.scenario.observations.some(
            row => row.nativeAnchor === target.id && row.outcome === 'passed'
          )
        ).equals(false)
        expect(m.taps).has.length(fault === 'no-progress' ? 1 : 0)
      }
    )

  async function pagingClock(
    work: (advance: (ms: number) => void) => Promise<void>
  ): Promise<void> {
    const actualNow = Date.now
    const actualTimeout = Object.getOwnPropertyDescriptor(
      AbortSignal,
      'timeout'
    )!
    const start = actualNow()
    let elapsed = 0
    const pending: Array<{ end: number; controller: AbortController }> = []
    Date.now = () => start + elapsed
    AbortSignal.timeout = (ms: number): AbortSignal => {
      const controller = new AbortController()
      pending.push({ end: elapsed + ms, controller })
      return controller.signal
    }
    try {
      await work(ms => {
        elapsed += ms
        for (const timer of pending)
          if (timer.end <= elapsed)
            timer.controller.abort(
              new Error('Observed native signal budget expired')
            )
      })
    } finally {
      Date.now = actualNow
      Object.defineProperty(AbortSignal, 'timeout', actualTimeout)
    }
  }

  it('keeps a progressing earlier control alive through the measured large-tree latency budget', async () => {
    const m = model()
    await pagingClock(async advance => {
      const drag = m.scenario.ui.device.dragAndDrop.bind(m.scenario.ui.device)
      let delayed = false
      m.scenario.ui.device.dragAndDrop = async (args, options) => {
        await drag(args, options)
        if (!delayed) {
          delayed = true
          advance(100000)
        }
      }
      await m.scenario.nativeAnchorReady(target, true)
      expect(
        m.scenario.observations.find(
          row => row.nativeEarlierControlFor === target.id
        )?.outcome
      ).equals('passed')
      expect(m.taps).deep.equals([])
      expect(
        m.scenario.observations.some(row => row.nativeAnchor === target.id)
      ).equals(false)
    })
  })

  it('retains exact two-page target progress after the real first-page work consumes the old shared budget', async () => {
    const m = model()
    await pagingClock(async advance => {
      const tap = m.scenario.ui.device.tapOnPoint.bind(m.scenario.ui.device)
      m.scenario.ui.device.tapOnPoint = async (args, options) => {
        await tap(args, options)
        if (m.taps.length === 1) advance(150000)
      }
      await m.scenario.anchor(target)
      expect(m.taps).has.length(2)
      expect(
        m.scenario.observations.find(
          row => row.nativeHistoryTarget === target.id
        )?.outcome
      ).equals('passed')
      expect(
        m.scenario.observations.find(row => row.nativeAnchor === target.id)
          ?.outcome
      ).equals('passed')
    })
  })

  for (const fault of ['earlier-budget', 'shared-budget', 'ordinary-budget'])
    it(
      'still refuses bounded native work after ' + fault + ' expires',
      async () => {
        const m = model(fault === 'ordinary-budget' ? 'loaded' : '')
        await pagingClock(async advance => {
          if (fault === 'shared-budget') {
            const tap = m.scenario.ui.device.tapOnPoint.bind(
              m.scenario.ui.device
            )
            m.scenario.ui.device.tapOnPoint = async (args, options) => {
              await tap(args, options)
              advance(310000)
            }
          } else {
            const drag = m.scenario.ui.device.dragAndDrop.bind(
              m.scenario.ui.device
            )
            m.scenario.ui.device.dragAndDrop = async (args, options) => {
              await drag(args, options)
              advance(fault === 'earlier-budget' ? 190000 : 100000)
            }
          }
          const error = await captureFailure(m.scenario.anchor(target))
          expect(String(error)).matches(/deadline|signal budget expired/)
          expect(
            m.scenario.observations.some(
              row => row.nativeAnchor === target.id && row.outcome === 'passed'
            )
          ).equals(false)
          expect(m.taps).has.length(fault === 'shared-budget' ? 1 : 0)
        })
      }
    )
})

describe('native E5 exact old outgoing quote route', function () {
  function route(
    surface: 'ios' | 'android' | 'web-wide',
    fault = ''
  ): {
    scenario: Scenarios
    calls: string[]
    stopped: Error
    cleanup: () => void
  } {
    const viewerId = userIdOfGumbo(1)
    const outgoing: Chat2Message = {
      id: 'msg_exact_old_outgoing',
      seq: 5,
      authorId: fault === 'wrong-outgoing-author' ? userIdOfGumbo(3) : viewerId,
      body: 'Earlier synthetic own message.'
    }
    const reply = message({
      id: 'msg_exact_recent_reply',
      seq: 236,
      body: 'Recent authenticated reply.',
      quote: {
        id: fault === 'wrong-target' ? 'msg_another_original' : outgoing.id,
        authorId: fault === 'wrong-quote-author' ? userIdOfGumbo(4) : viewerId,
        authorName: 'Juan S',
        snippet: outgoing.body,
        status: 'unavailable'
      }
    })
    const messages =
      fault === 'absent'
        ? []
        : fault === 'ambiguous'
          ? [reply, { ...reply, id: 'msg_other_recent_reply' }]
          : [
              {
                ...reply,
                status:
                  fault === 'invalid'
                    ? ('invalid' as const)
                    : fault === 'removed'
                      ? ('removed' as const)
                      : reply.status
              }
            ]
    const calls: string[] = []
    const stopped = Error('Unchanged exact outgoing action boundary reached')
    let jumped = false
    const directory = mkdtempSync(join(tmpdir(), 'chat-e5-quote-unit-'))
    const response = join(directory, 'response.json')
    const control = join(directory, 'control.cjs')
    writeFileSync(
      response,
      JSON.stringify({
        ownershipId: 'chat-e5-unit',
        uiActions: false,
        ok: true,
        lastEvent: 0,
        events: []
      })
    )
    writeFileSync(
      control,
      "const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));if(input.action!=='snapshot')process.exit(3);console.log(JSON.stringify(require('./response.json')))"
    )
    const hash = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex')
    const incoming: Chat2Message = {
      id: 'msg_current_incoming',
      seq: 231,
      body: 'Current synthetic message.',
      authorId: userIdOfGumbo(2)
    }
    const actual = {
      native: surface !== 'web-wide',
      surface,
      metrics: () => ({ coarse: false }),
      hideKeyboard: async () => {},
      absent: async () => {},
      present: async () => {},
      publicBounds: async () => ({
        x: 0,
        y: 100,
        width: 250,
        height: 100
      }),
      steps: [],
      shot: async () => {},
      device: {
        assertVisible: async () => ({}),
        screenshot: async () => captureImages[0]
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      viewerId,
      group: 'cnv_quote_unit',
      observations: [],
      f: {
        ownershipId: 'chat-e5-unit',
        control: {
          executable: process.execPath,
          args: [control],
          script: control,
          sha256: hash(control),
          dependencies: [{ path: response, sha256: hash(response) }]
        },
        messages: {
          target: incoming,
          incoming,
          outgoing,
          long: { ...incoming, id: 'msg_current_long', seq: 238 },
          file: { ...incoming, id: 'msg_current_file', seq: 239 }
        }
      },
      openGroup: async () => {},
      check: async (name: string, work: () => Promise<void>) => {
        if (name.startsWith('E5 incoming/outgoing')) await work()
      },
      client: async () => ({ chatPins: async () => [] }),
      incomingReservation: async () => ({}),
      protocolPeer: async () => ({
        engine: {
          open: async (id: string) => {
            expect(id).equals('cnv_quote_unit')
            calls.push('authenticated-current-replies')
            return { messages }
          }
        }
      }),
      identityLegacyAnchor: async (
        target: Chat2Message,
        baseline: { text: Chat2Message; reply: Chat2Message }
      ) => {
        expect(target).equals(outgoing)
        expect(baseline.text).equals(outgoing)
        expect(baseline.reply).deep.equals({
          id: reply.id,
          seq: reply.seq,
          body: reply.body,
          authorId: reply.senderUserId
        })
        calls.push('observed-exact-row-quote-jump')
        jumped = true
      },
      action: async (target: Chat2Message) => {
        if (target.id === outgoing.id) {
          expect(target).equals(outgoing)
          if (actual.native)
            expect(
              jumped,
              'Native old outgoing must first use its unique authenticated reply quote'
            ).equals(true)
          calls.push('unchanged-exact-outgoing-action')
          throw stopped
        }
      },
      menuState: async () => ({ preview: true }),
      dismiss: async () => {}
    }) as Scenarios
    return {
      scenario,
      calls,
      stopped,
      cleanup: () => {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
  for (const surface of ['ios', 'android'] as const)
    it(
      'reaches the same old outgoing through its authenticated current reply on ' +
        surface,
      async () => {
        const m = route(surface)
        try {
          expect(await captureFailure(m.scenario.E5())).equals(m.stopped)
          expect(m.calls).deep.equals([
            'authenticated-current-replies',
            'observed-exact-row-quote-jump',
            'unchanged-exact-outgoing-action'
          ])
        } finally {
          m.cleanup()
        }
      }
    )
  it('leaves the browser outgoing navigation path unchanged', async () => {
    const m = route('web-wide')
    try {
      expect(await captureFailure(m.scenario.E5())).equals(m.stopped)
      expect(m.calls).deep.equals(['unchanged-exact-outgoing-action'])
    } finally {
      m.cleanup()
    }
  })
  for (const fault of [
    'absent',
    'ambiguous',
    'invalid',
    'removed',
    'wrong-target',
    'wrong-quote-author',
    'wrong-outgoing-author'
  ])
    it('refuses an unproved old outgoing quote route: ' + fault, async () => {
      const m = route('ios', fault)
      try {
        const error = String(await captureFailure(m.scenario.E5()))
        expect(error).matches(
          /Unique authenticated current reply|Exact own outgoing quote author/
        )
        expect(m.calls).not.includes('observed-exact-row-quote-jump')
        expect(m.calls).not.includes('unchanged-exact-outgoing-action')
      } finally {
        m.cleanup()
      }
    })
})

describe('native pinned jump settlement', function () {
  const target: Chat2Message = {
    id: 'msg-pin-original',
    seq: 231,
    body: 'Synthetic practice update.',
    authorId: userIdOfGumbo(9)
  }
  function model(
    mode = 'delayed',
    surface: 'android' | 'ios' = 'android'
  ): {
    scenario: Scenarios
    events: string[]
    reads: () => number
  } {
    const events: string[] = []
    let reads = 0
    let selected = false
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native: true,
      surface,
      deadline: AbortSignal.timeout(
        ['pending', 'missing-target', 'changing-band', 'changing-ids'].includes(
          mode
        )
          ? 40
          : 10000
      ),
      nodes: async (_parent?: string, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        reads++
        if (mode === 'transport') throw Error('Public hierarchy disconnected')
        const pending = mode === 'pending' || reads < 3
        const bottom =
          mode === 'changing-band'
            ? reads % 2 === 0
              ? 1803
              : 1929
            : reads < 4
              ? 1803
              : 1929
        return [
          {
            id: 'chat-message-history',
            bounds: { x: 0, y: 0, width: 1080, height: 2400 }
          },
          {
            id: 'chat-conversation-identity',
            bounds: { x: 42, y: 150, width: 996, height: 126 }
          },
          {
            id: 'chat-pinned-band',
            bounds: { x: 42, y: 276, width: 996, height: 156 }
          },
          {
            id: 'chat-composer-band',
            bounds: { x: 42, y: bottom, width: 996, height: 142 }
          },
          { id: 'chat-bubble-msg-recent' },
          ...(pending ? [{ id: 'chat-history-jump-cancel' }] : []),
          ...(mode === 'retry' ? [{ id: 'chat-history-jump-retry' }] : []),
          ...(reads < 2 || mode === 'missing-target'
            ? []
            : [
                {
                  id: 'chat-bubble-' + target.id,
                  bounds: {
                    x: 126,
                    y: reads < 3 ? 0 : reads < 4 ? 600 : 626,
                    width: 755,
                    height: reads < 3 ? -44715 : 180
                  }
                }
              ]),
          ...(reads >= 4
            ? [
                {
                  id:
                    'chat-bubble-msg-loaded-' +
                    (mode === 'changing-ids' ? reads : 4)
                }
              ]
            : [])
        ]
      },
      visible: async (selector: { id?: string; text?: string }) =>
        selector.id === 'chat-pinned-summary'
          ? mode !== 'no-summary'
          : selector.text === '^Pinned messages$' || mode !== 'missing-pin',
      present: async (id: string) => {
        expect(id).equals('chat-bubble-' + target.id)
        events.push('present')
      },
      device: {
        tapOn: async (selector: { id?: string; text?: string }) => {
          if (selector.id === 'chat-pin-' + target.id) selected = true
          events.push(selector.id ?? selector.text!)
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      observations: [],
      f: { messages: { target } },
      nativeHistoryTarget: async () => {
        if (selected)
          expect(
            reads,
            'Selected pin must settle before manual paging'
          ).at.least(5)
        events.push('history')
      },
      nativeAnchorReady: async () => {
        events.push('frame')
        return []
      }
    }) as Scenarios
    return { scenario, events, reads: () => reads }
  }

  for (const surface of ['android', 'ios'] as const)
    it(
      'waits for the actual selected pin target and stable native window on ' +
        surface,
      async () => {
        const m = model('delayed', surface)
        await m.scenario.anchor(target)
        expect(m.reads()).at.least(5)
        expect(m.events).deep.equals([
          'chat-pinned-summary',
          'chat-pin-' + target.id,
          'history',
          'frame',
          'present'
        ])
      }
    )

  for (const mode of [
    'retry',
    'transport',
    'pending',
    'missing-target',
    'changing-band',
    'changing-ids'
  ])
    it(
      'refuses unsettled native pin navigation before paging: ' + mode,
      async () => {
        const m = model(mode)
        const error = String(await captureFailure(m.scenario.anchor(target)))
        expect(error).matches(
          mode === 'retry'
            ? /pin.*jump.*fail/i
            : mode === 'transport'
              ? /Public hierarchy disconnected/
              : /abort|timeout/i
        )
        expect(m.events).not.includes('history')
        expect(m.events).not.includes('frame')
      }
    )

  for (const mode of ['no-summary', 'missing-pin'])
    it(
      'retains ordinary native history fallback without a selected pin: ' +
        mode,
      async () => {
        const m = model(mode)
        await m.scenario.anchor(target)
        expect(m.reads()).equals(0)
        expect(m.events.slice(-3)).deep.equals(['history', 'frame', 'present'])
        if (mode === 'missing-pin') expect(m.events).includes('^Cancel$')
      }
    )
})

describe('native earlier-control exact-target handoff', function () {
  this.timeout(15000)
  const target: Chat2Message = {
    id: 'msg-preserved-reply',
    seq: 237,
    body: 'Practice update: bring water.',
    authorId: userIdOfGumbo(5)
  }

  function handoffModel(mode = 'prepend'): {
    scenario: Scenarios
    earlierMoves: () => number
    targetMoves: () => number
    taps: unknown[]
    presents: string[]
  } {
    const controller = new AbortController()
    const taps: unknown[] = []
    const presents: string[] = []
    let earlierMoves = 0
    let targetMoves = 0
    let loaded = mode === 'initial'
    let targetBox = { x: 126, y: 0, width: 755, height: -39391 }
    const band = (): { top: number; bottom: number } => ({
      top: 432,
      bottom: earlierMoves === 0 ? 1803 : 1929
    })
    const nodes = (): PublicNode[] => {
      const b = band()
      const earlierBox =
        mode === 'safe'
          ? { x: 42, y: 425, width: 996, height: 144 }
          : {
              x: 42,
              y: 0,
              width: 996,
              height:
                earlierMoves === 0
                  ? -34498
                  : earlierMoves === 1
                    ? -33508
                    : -65980
            }
      return [
        {
          id: 'chat-message-history',
          type: 'ScrollView',
          bounds: { x: 0, y: 0, width: 1080, height: 2400 }
        },
        {
          id: 'chat-conversation-identity',
          type: 'Button',
          bounds: { x: 168, y: 136, width: 744, height: 123 }
        },
        {
          id: 'chat-pinned-band',
          bounds: { x: 42, y: 262, width: 996, height: 170 }
        },
        {
          id: 'chat-composer-band',
          bounds: { x: 42, y: b.bottom, width: 996, height: 142 }
        },
        ...(loaded && ['initial', 'final', 'safe'].includes(mode)
          ? []
          : [
              {
                type: 'Button',
                text: 'Load earlier messages',
                bounds: earlierBox
              }
            ]),
        {
          id: 'chat-bubble-msg-unrelated',
          bounds: { x: 126, y: 700, width: 755, height: 267 }
        },
        ...(loaded
          ? Array.from({ length: mode === 'duplicate' ? 2 : 1 }, () => ({
              id: 'chat-bubble-' + target.id,
              bounds: { ...targetBox }
            }))
          : [])
      ]
    }
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native: true,
      surface: 'android',
      deadline: controller.signal,
      steps: [],
      visible: async () => false,
      device: {
        hierarchy: async (options?: { signal: AbortSignal }) => {
          options?.signal.throwIfAborted()
          return { type: 'FrameLayout', children: nodes() }
        },
        platformInfo: async (options?: { signal: AbortSignal }) => {
          options?.signal.throwIfAborted()
          return { screenWidth: 1080, screenHeight: 2400 }
        },
        swipe: async (
          args: { startY: number; endY: number; duration: number },
          options?: { signal: AbortSignal }
        ) => {
          options?.signal.throwIfAborted()
          const b = band()
          expect(Math.min(args.startY, args.endY)).greaterThan(b.top)
          expect(Math.max(args.startY, args.endY)).lessThan(b.bottom)
          expect(args.duration).equals(200)
          if (!loaded) {
            expect(args.endY).greaterThan(args.startY)
            earlierMoves++
            if (mode === 'expired')
              controller.abort(new Error('Parent native deadline expired'))
            if (
              mode !== 'absent' &&
              (earlierMoves === 2 || ['final', 'safe'].includes(mode))
            )
              loaded = true
            return
          }
          targetMoves++
          if (mode === 'target-stuck') return
          targetBox =
            mode === 'target-wrong'
              ? { ...targetBox, height: targetBox.height - 100 }
              : mode === 'target-repeat'
                ? targetMoves === 1
                  ? { x: 126, y: 2200, width: 755, height: 200 }
                  : { x: 126, y: 0, width: 755, height: 300 }
                : { x: 126, y: 700, width: 755, height: 267 }
        },
        tapOnPoint: async (point: unknown) => {
          taps.push(point)
          throw Error('No earlier Button tap is permitted after target arrival')
        },
        assertVisible: async (selector: { id: string }) => {
          expect(selector.id).equals('chat-bubble-' + target.id)
          expect(loaded).equals(true)
          expect(targetBox.height).greaterThan(0)
          expect(targetBox.y).at.least(band().top + 7.5)
          expect(targetBox.y + targetBox.height).at.most(band().bottom - 7.5)
          presents.push(selector.id)
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      f: { messages: { target } },
      observations: []
    }) as Scenarios
    return {
      scenario,
      earlierMoves: () => earlierMoves,
      targetMoves: () => targetMoves,
      taps,
      presents
    }
  }

  const handoff = (scenario: Scenarios): Record<string, unknown> =>
    scenario.observations.find(
      row => row.nativeEarlierControlFor === target.id
    )!

  it('hands off a newly loaded exact reply before comparing the obsolete prepended control', async () => {
    const m = handoffModel()
    await m.scenario.anchor(target)
    expect(m.earlierMoves()).equals(2)
    expect(m.targetMoves()).equals(1)
    expect(m.taps).deep.equals([])
    expect(m.presents).deep.equals(['chat-bubble-' + target.id])
    expect(handoff(m.scenario).outcome).equals('target-loaded')
    expect(handoff(m.scenario).loadedTarget).deep.equals({
      id: target.id,
      bounds: { x: 126, y: 0, width: 755, height: -39391 }
    })
    expect(
      m.scenario.observations.find(row => row.nativeAnchor === target.id)
        ?.outcome
    ).equals('passed')
  })

  it('hands off an exact initial arrival before requiring an obsolete earlier Button', async () => {
    const m = handoffModel('initial')
    const observed = await m.scenario.nativeAnchorReady(target, true)
    expect(
      observed.filter(n => n.id === 'chat-bubble-' + target.id)
    ).has.length(1)
    expect(m.earlierMoves()).equals(0)
    expect(m.targetMoves()).equals(0)
    expect(m.presents).deep.equals([])
    expect(handoff(m.scenario).outcome).equals('target-loaded')
    expect(
      m.scenario.observations.some(row => row.nativeAnchor != null)
    ).equals(false)
  })

  for (const mode of ['final', 'safe'])
    it(
      'retains outer target framing when the earlier Button disappears: ' +
        mode,
      async () => {
        const m = handoffModel(mode)
        await m.scenario.anchor(target)
        expect(m.earlierMoves()).equals(1)
        expect(m.targetMoves()).equals(1)
        expect(m.taps).deep.equals([])
        expect(m.presents).deep.equals(['chat-bubble-' + target.id])
        expect(handoff(m.scenario).outcome).equals('target-loaded')
        expect(
          m.scenario.observations.find(row => row.nativeAnchor === target.id)
            ?.outcome
        ).equals('passed')
      }
    )

  it('rejects the same backwards frontier while only an unrelated target exists', async () => {
    const m = handoffModel('absent')
    expect(String(await captureFailure(m.scenario.anchor(target)))).includes(
      'Exact target must advance in the requested native gesture direction'
    )
    expect(m.earlierMoves()).equals(2)
    expect(m.targetMoves()).equals(0)
    expect(handoff(m.scenario).outcome).not.equals('target-loaded')
    expect(m.presents).deep.equals([])
    expect(m.taps).deep.equals([])
  })

  it('rejects duplicated exact arrivals before any handoff or target framing', async () => {
    const m = handoffModel('duplicate')
    expect(String(await captureFailure(m.scenario.anchor(target)))).includes(
      'Unique exact native history target required'
    )
    expect(m.earlierMoves()).equals(2)
    expect(m.targetMoves()).equals(0)
    expect(handoff(m.scenario).outcome).not.equals('target-loaded')
    expect(m.presents).deep.equals([])
    expect(m.taps).deep.equals([])
  })

  for (const mode of ['target-stuck', 'target-wrong', 'target-repeat'])
    it(
      'does not let loaded-target handoff waive ordinary geometry: ' + mode,
      async () => {
        const m = handoffModel(mode)
        const error = String(await captureFailure(m.scenario.anchor(target)))
        expect(error).includes(
          mode === 'target-repeat'
            ? 'Only one target crossing'
            : 'Exact target must advance'
        )
        expect(handoff(m.scenario).outcome).equals('target-loaded')
        expect(
          m.scenario.observations.find(row => row.nativeAnchor === target.id)
            ?.outcome
        ).not.equals('passed')
        expect(m.presents).deep.equals([])
        expect(m.taps).deep.equals([])
      }
    )

  it('retains an aborting parent deadline before target handoff', async () => {
    const m = handoffModel('expired')
    expect(String(await captureFailure(m.scenario.anchor(target)))).includes(
      'Parent native deadline expired'
    )
    expect(m.earlierMoves()).equals(1)
    expect(m.targetMoves()).equals(0)
    expect(handoff(m.scenario).outcome).not.equals('target-loaded')
    expect(m.presents).deep.equals([])
    expect(m.taps).deep.equals([])
  })
})

describe('web post-lifecycle continuity public device ownership', function () {
  function rowModel(mode = 'linked'): {
    scenario: Scenarios
    close: () => void
    calls: string[]
  } {
    const title = 'Chrome on a test system (this device)'
    const ownSubtitle =
      mode === 'pending-sibling-linked'
        ? 'Web · Not linked yet'
        : 'Web · Linked'
    const own = `<div data-row="own"><div data-text="own"><div style="opacity:1">${title}</div><div>${ownSubtitle}</div></div></div>`
    const other =
      '<div data-row="other"><div data-text="other"><div>Protocol device</div><div>Web · Linked</div></div></div>'
    const page = new JSDOM(`<h1>Chat devices</h1><div>${own}${other}</div>`, {
      url: 'https://fixture.example.test/chat/devices',
      runScripts: 'outside-only'
    })
    const document = page.window.document
    const text = document.querySelector('[data-text="own"]')!
    if (mode === 'duplicate-title')
      text.insertAdjacentHTML('beforeend', `<div>${title}</div>`)
    if (mode === 'linked-in-other-container')
      text.lastElementChild!.replaceWith(document.createElement('div'))
    if (mode === 'nested-linked')
      text.lastElementChild!.innerHTML = '<div>Web · Linked</div>'
    if (mode === 'login')
      document.body.insertAdjacentHTML('beforeend', '<input type="password">')
    const marker = text.firstElementChild as HTMLElement
    if (mode === 'hidden') marker.style.visibility = 'hidden'
    if (mode === 'loading') document.querySelector('[data-row="own"]')!.remove()
    Object.defineProperty(
      page.window.HTMLElement.prototype,
      'getBoundingClientRect',
      {
        configurable: true,
        value: () => ({
          x: 20,
          y: 120,
          width: 250,
          height: 24,
          top: 120,
          bottom: 144,
          left: 20,
          right: 270
        })
      }
    )
    page.window.HTMLElement.prototype.scrollIntoView = () => {}
    const calls: string[] = []
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      native: false,
      surface: 'web-narrow',
      open: async (route: string) => {
        calls.push(route)
      },
      dom: async (script: string) =>
        await page.window.eval('(async()=>{' + script + '})()'),
      device: {
        assertVisible: async (selector: { text: string; timeout?: number }) => {
          if (selector.text === '^Chat devices$') return
          expect(selector.text).equals(
            '^Chrome on a test system \\(this device\\)$'
          )
          expect(selector.timeout).equals(15000)
          if (mode === 'loading')
            document.body.insertAdjacentHTML('beforeend', own)
        },
        assertNotVisible: async (selector: { text: string }) => {
          calls.push(selector.text)
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui
    }) as Scenarios
    return {
      scenario,
      close: () => {
        page.window.close()
      },
      calls
    }
  }

  it('proves Linked only in the exact current title direct text container', async () => {
    const m = rowModel()
    try {
      const actual = await m.scenario.webContinuationDeviceUi({
        name: 'Chrome on a test system'
      })
      expect(actual.label).equals('Chrome on a test system (this device)')
      expect(actual.linkedText).equals('Web · Linked')
      expect(m.calls).deep.equals([
        '/chat/devices',
        '^Link this device$',
        '^Reset chat$'
      ])
    } finally {
      m.close()
    }
  })
  it('waits for the exact own row after the device page header appears', async () => {
    const m = rowModel('loading')
    try {
      const actual = await m.scenario.webContinuationDeviceUi({
        name: 'Chrome on a test system'
      })
      expect(actual.linkedText).equals('Web · Linked')
    } finally {
      m.close()
    }
  })
  for (const mode of [
    'pending-sibling-linked',
    'linked-in-other-container',
    'nested-linked'
  ])
    it(
      'rejects a current row without its own direct Linked subtitle: ' + mode,
      async () => {
        const m = rowModel(mode)
        try {
          const error = await captureFailure(
            m.scenario.webContinuationDeviceUi({
              name: 'Chrome on a test system'
            })
          )
          expect(String(error)).matches(/own direct subtitle/)
        } finally {
          m.close()
        }
      }
    )
  for (const mode of ['duplicate-title', 'hidden', 'login'])
    it(
      'rejects an unproved installed public device marker: ' + mode,
      async () => {
        const m = rowModel(mode)
        try {
          const error = await captureFailure(
            m.scenario.webContinuationDeviceUi({
              name: 'Chrome on a test system'
            })
          )
          expect(String(error)).matches(
            /Unique actual|Visible actual|login forbidden/
          )
        } finally {
          m.close()
        }
      }
    )
})

describe('web post-lifecycle continuity cryptographic preconditions', function () {
  function policyModel(): {
    scenario: Scenarios
    state: Parameters<Scenarios['verifyWebContinuation']>[0]
    plan: Parameters<Scenarios['verifyWebContinuation']>[1]
    baseline: Parameters<Scenarios['verifyWebContinuation']>[2]
  } {
    const viewerId = userIdOfGumbo(9)
    const replacement = {
      id: 'cdv_replacement',
      name: 'Chrome on a test system',
      platform: 'web' as const,
      boxPublicKey: 'synthetic-public-box',
      signPublicKey: 'synthetic-public-sign',
      createdAt: '2026-01-02T00:00:00.000Z'
    }
    const originalRevokedAt = '2026-01-02T00:00:01.000Z'
    const baseline = {
      actor: 'Willie',
      deviceId: 'cdv_original',
      identityId: 'identity-original',
      identityPublicKey: 'synthetic-public-identity',
      pukGeneration: 1,
      pukPublicKey: 'synthetic-public-puk-one',
      safetyNumber: '1'.repeat(60),
      text: {
        id: 'msg_text',
        seq: 1,
        body: 'Synthetic preserved text.',
        authorId: viewerId
      },
      reply: {
        id: 'msg_reply',
        seq: 2,
        body: 'Synthetic preserved reply.',
        authorId: viewerId
      },
      file: {
        id: 'msg_file',
        seq: 3,
        body: 'Synthetic preserved photo.',
        authorId: viewerId
      },
      textMentions: [userIdOfGumbo(8)],
      replyMentions: []
    }
    const ref = {
      path: '/var/app/synthetic-evidence.json',
      sha256: '0'.repeat(64)
    }
    const plan = {
      schema: 1 as const,
      kind: 'post-lifecycle-web-continuity' as const,
      applicationSource: 'a'.repeat(40),
      harnessSource: 'b'.repeat(40),
      baseline: ref,
      revocationEvidence: ref,
      historicalI1: [ref],
      review: ref,
      installedDeviceObservation: ref,
      originalRevokedAt,
      replacement
    }
    const state = {
      userId: viewerId,
      devices: [
        {
          ...replacement,
          id: baseline.deviceId,
          revokedAt: originalRevokedAt,
          linked: false,
          current: false,
          lastSeenAt: '2026-01-02T00:00:00.000Z'
        },
        {
          ...replacement,
          revokedAt: null,
          linked: true,
          current: true,
          lastSeenAt: '2026-01-02T00:01:00.000Z'
        }
      ],
      keys: {
        deviceId: replacement.id,
        linked: true,
        pukNeedsRotation: false,
        identity: {
          id: baseline.identityId,
          publicKey: baseline.identityPublicKey,
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        generations: [
          {
            generation: 1,
            publicKey: baseline.pukPublicKey,
            signature: 'synthetic-public-signature-one',
            previousKeysBox: null
          },
          {
            generation: 2,
            publicKey: 'synthetic-public-puk-two',
            signature: 'synthetic-public-signature-two',
            previousKeysBox: 'synthetic-wrapped-previous-public-chain'
          }
        ]
      }
    }
    return {
      scenario: Object.assign(Object.create(Scenarios.prototype), {
        viewerId
      }) as Scenarios,
      state,
      plan,
      baseline
    }
  }

  it('accepts the pinned linked replacement while retaining exact original revocation and public chain', () => {
    const m = policyModel()
    const actual = m.scenario.verifyWebContinuation(m.state, m.plan, m.baseline)
    expect(actual.identity).deep.equals(m.state.keys.identity)
    expect(actual.generations).deep.equals(m.state.keys.generations)
    expect(actual.roster.map(device => device.id)).deep.equals([
      'cdv_original',
      'cdv_replacement'
    ])
    expect(
      actual.roster.every(
        device => !('lastSeenAt' in device) && !('current' in device)
      )
    ).equals(true)
  })
  for (const fault of [
    'actor',
    'replacement',
    'public-key',
    'two-current',
    'unlinked',
    'revoked',
    'original-unrevoked',
    'original-timestamp',
    'identity',
    'missing-puk',
    'key-session',
    'pending-rotation'
  ])
    it('rejects an invalid post-lifecycle policy: ' + fault, () => {
      const m = policyModel()
      if (fault === 'actor') m.state.userId = userIdOfGumbo(7)
      if (fault === 'replacement') m.state.devices[1].id = 'cdv_wrong'
      if (fault === 'public-key')
        m.state.devices[1].signPublicKey = 'different-public-sign'
      if (fault === 'two-current') m.state.devices[0].current = true
      if (fault === 'unlinked') m.state.devices[1].linked = false
      if (fault === 'revoked')
        m.state.devices[1].revokedAt = m.plan.originalRevokedAt
      if (fault === 'original-unrevoked') m.state.devices[0].revokedAt = null
      if (fault === 'original-timestamp')
        m.state.devices[0].revokedAt = '2026-01-03T00:00:00.000Z'
      if (fault === 'identity')
        m.state.keys.identity!.publicKey = 'different-public-identity'
      if (fault === 'missing-puk') m.state.keys.generations.shift()
      if (fault === 'key-session')
        m.state.keys.deviceId = 'cdv_provider-session'
      if (fault === 'pending-rotation') m.state.keys.pukNeedsRotation = true
      expect(() =>
        m.scenario.verifyWebContinuation(m.state, m.plan, m.baseline)
      ).throws()
    })
  it('leaves original I1 rejecting the revoked original before sign-in or history', async () => {
    const m = policyModel()
    const calls: string[] = []
    Object.assign(m.scenario, {
      viewerKey: m.baseline.actor,
      ui: { surface: 'web-narrow', native: false },
      f: { identityCompatibility: { legacy: { 'web-narrow': m.baseline } } },
      check: async (_label: string, work: () => Promise<void>) => {
        await work()
      },
      client: async () => ({
        myChatKeys: async () => m.state.keys,
        chatDevices: async () => m.state.devices
      }),
      signIn: async () => {
        calls.push('sign-in')
      },
      legacyHistoryAndSafety: async () => {
        calls.push('history')
      }
    })
    const error = await captureFailure(m.scenario.I1())
    expect(String(error)).includes(
      'Original installed device required before reopen'
    )
    expect(calls).deep.equals([])
  })
  async function orchestration(fault = ''): Promise<{
    error: unknown
    calls: string[]
    observations: Array<Record<string, unknown>>
  }> {
    const m = policyModel()
    const directory = mkdtempSync(join(tmpdir(), 'chat-web-continuation-'))
    const hash = (file: string): string =>
      createHash('sha256').update(readFileSync(file)).digest('hex')
    const evidence = (
      name: string,
      value: unknown
    ): { path: string; sha256: string } => {
      const file = join(directory, name)
      writeFileSync(
        file,
        typeof value === 'string' ? value : JSON.stringify(value),
        { mode: 0o600 }
      )
      return { path: file, sha256: hash(file) }
    }
    const image = join(directory, 'synthetic.png')
    writeFileSync(image, captureImages[0], { mode: 0o600 })
    const kinds = [
      'chat-list',
      'conversation',
      'floating-pins',
      'message-actions',
      'reply-keyboard',
      'info',
      'info-members',
      'mentions',
      'mention-composer',
      'attention'
    ]
    const files = ['web-wide', 'web-narrow', 'web-touch', 'ios', 'android']
      .flatMap(surface =>
        kinds.map(kind => surface + '-' + kind + '-after.png')
      )
      .concat([
        'ios-keyboard-pins-after.png',
        'android-keyboard-pins-after.png',
        'web-320-composer-after.png'
      ])
    const archive = evidence('unit-archive.json', {
      entries: files.map(file => ({
        file,
        path: image,
        source: m.plan.applicationSource,
        sha256: hash(image)
      }))
    })
    m.plan.baseline = evidence('baseline.json', {
      identityCompatibility: {
        legacy: { 'web-narrow': m.baseline },
        fullWidthActors: []
      }
    })
    m.plan.revocationEvidence = evidence('revocation.json', {
      readOnly: true,
      rows: [
        {
          surface: 'web-narrow',
          expectedDevice: m.baseline.deviceId,
          rows: [
            { id: m.baseline.deviceId, revoked_at: m.plan.originalRevokedAt }
          ]
        }
      ]
    })
    m.plan.historicalI1 = [
      evidence('historical-i1.json', {
        scenario: 'I1',
        surface: 'web-narrow',
        outcome: 'passed',
        diagnosticOnly: false,
        completedScenarios: ['I1'],
        source: 'c'.repeat(40)
      })
    ]
    m.plan.review = evidence(
      'review.md',
      'Synthetic reviewed compatibility comparison fixture'
    )
    const hierarchy = evidence('public-hierarchy.json', {
      publicMarker: 'Synthetic this-device observation fixture'
    })
    m.plan.installedDeviceObservation = evidence('installed-observation.json', {
      kind: 'installed-web-device-public-ui',
      applicationSource: m.plan.applicationSource,
      harnessSource: m.plan.harnessSource,
      userId: m.state.userId,
      thisDeviceLabel: m.plan.replacement.name + ' (this device)',
      currentSessionDeviceId: m.plan.replacement.id,
      replacement: m.plan.replacement,
      screenshot: image,
      screenshotSha256: hash(image),
      publicHierarchy: hierarchy.path,
      publicHierarchySha256: hierarchy.sha256
    })
    const descriptor = evidence('continuation.json', m.plan)
    const keys = [
      'CHAT2_ARTIFACTS',
      'CHAT2_SOURCE',
      'CHAT2_WEB_CONTINUATION_FILE',
      'CHAT2_WEB_CONTINUATION_SHA256'
    ] as const
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    process.env.CHAT2_ARTIFACTS = directory
    process.env.CHAT2_SOURCE = m.plan.applicationSource
    process.env.CHAT2_WEB_CONTINUATION_FILE = descriptor.path
    process.env.CHAT2_WEB_CONTINUATION_SHA256 = descriptor.sha256
    const calls: string[] = []
    let draft = ''
    let sentBody = ''
    let reopened = false
    let publicReads = 0
    const post = (): {
      id: string
      seq: number
      body: string
      senderUserId: string
      status: 'ok'
    } => ({
      id:
        fault === 'persisted-id' && reopened
          ? 'msg_changed_persisted'
          : 'msg_current_send',
      seq: 400,
      body: sentBody,
      senderUserId: m.state.userId,
      status: 'ok'
    })
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      surface: 'web-narrow',
      native: false,
      binding: {
        applicationSource: m.plan.applicationSource,
        harnessSource: m.plan.harnessSource
      },
      runDir: directory,
      replaceDraft: async (value: string) => {
        draft = value
      },
      draft: async () => draft,
      text: async (label: string) => {
        expect(label).equals('Send')
        calls.push('send')
        if (fault === 'send-error') throw Error('Public Send failed')
        expect(draft).not.equals('')
        sentBody = draft
      },
      present: async (id: string) => {
        expect(id).equals('chat-composer')
        calls.push('composer-after-reopen')
      },
      shot: async (kind: string) => {
        calls.push('shot:' + kind)
      },
      device: {
        openLink: async (args: { link: string }) => {
          expect(args.link).equals(
            'https://fixture.example.test/chat/cnv_mixed'
          )
          calls.push('navigate-reopen')
          reopened = true
        },
        assertNotVisible: async (selector: { text: string }) => {
          expect(selector.text).equals('^Link this device$')
          if (fault === 'link-on-reopen')
            throw Error('Unexpected linking fallback')
        },
        assertVisible: async (selector: {
          text: string
          childOf: { id: string }
        }) => {
          expect(reopened).equals(true)
          expect(selector.text).equals('^' + sentBody + '$')
          expect(selector.childOf.id).equals('chat-bubble-msg_current_send')
          if (fault === 'lost-public-message')
            throw Error('Persisted public message is absent')
          calls.push('persisted-public-body')
        }
      }
    }) as Chat2UI
    Object.assign(m.scenario, {
      ui,
      viewerKey: m.baseline.actor,
      group: 'cnv_mixed',
      observations: [],
      f: {
        identityCompatibility: {
          legacy: { 'web-narrow': m.baseline },
          fullWidthActors: []
        },
        afterArchive: archive.path,
        webUrl: 'https://fixture.example.test'
      },
      check: async (_name: string, work: () => Promise<void>) => {
        await work()
        calls.push('case-passed')
      },
      webContinuationState: async () => {
        publicReads++
        const state = JSON.parse(JSON.stringify(m.state)) as typeof m.state
        if (fault === 'public-key-after-send' && publicReads >= 3)
          state.devices[1].boxPublicKey = 'different-public-box'
        if (fault === 'roster-after-send' && publicReads >= 3)
          state.devices.push({
            ...state.devices[1],
            id: 'cdv_unexpected',
            current: false
          })
        if (fault === 'chain-after-send' && publicReads >= 3)
          state.keys.generations.push({
            generation: 3,
            publicKey: 'different-public-puk',
            signature: 'different-public-signature',
            previousKeysBox: null
          })
        if (fault === 'device-after-reopen' && reopened)
          state.keys.deviceId = 'cdv_other_browser'
        return state
      },
      webContinuationDeviceUi: async () => {
        calls.push('public-device-marker')
        if (fault === 'login-before-history')
          throw Error('Existing signed-in device required; login forbidden')
        return {
          label: m.plan.replacement.name + ' (this device)',
          linkedText: 'Web · Linked'
        }
      },
      legacyHistoryAndSafety: async (baseline: typeof m.baseline) => {
        expect(baseline).deep.equals(m.baseline)
        calls.push('unchanged-legacy-oracles')
      },
      anchor: async (message: Chat2Message) => {
        expect(message.id).equals('msg_current_send')
        calls.push('anchor-persisted')
      },
      signIn: async () => {
        calls.push('forbidden-sign-in')
        throw Error('W1 must not sign in')
      },
      approveBrowserLink: async () => {
        calls.push('forbidden-link')
        throw Error('W1 must not approve a link')
      },
      protocolPeer: async () => ({
        engine: {
          open: async () => ({
            messages:
              sentBody === ''
                ? []
                : fault === 'duplicate-peer'
                  ? [post(), { ...post(), id: 'msg_duplicate' }]
                  : [post()]
          })
        }
      })
    })
    let error: unknown
    try {
      await m.scenario.W1()
    } catch (failure) {
      error = failure
    } finally {
      for (const key of keys) {
        if (before[key] == null) Reflect.deleteProperty(process.env, key)
        else process.env[key] = before[key]
      }
      rmSync(directory, { recursive: true, force: true })
    }
    return { error, calls, observations: m.scenario.observations }
  }

  it('orchestration sends once, really navigates, and verifies the same persisted message and identity', async () => {
    const result = await orchestration()
    expect(result.error).equals(undefined)
    expect(result.calls.filter(call => call === 'send')).deep.equals(['send'])
    expect(result.calls.filter(call => call === 'navigate-reopen')).deep.equals(
      ['navigate-reopen']
    )
    expect(result.calls).includes('unchanged-legacy-oracles')
    expect(result.calls).includes('persisted-public-body')
    expect(result.calls.at(-1)).equals('case-passed')
    expect(result.calls).not.includes('forbidden-sign-in')
    expect(result.calls).not.includes('forbidden-link')
    const proof = result.observations.find(
      row => row.postLifecycleWebContinuity === true
    )!
    expect(proof.originalDeviceContinuityClaimed).equals(false)
    expect(proof.currentPublicIdentityAndChainUnchanged).equals(true)
    expect(proof.rosterAndPublicKeysUnchanged).equals(true)
  })
  for (const fault of [
    'duplicate-peer',
    'persisted-id',
    'lost-public-message',
    'public-key-after-send',
    'roster-after-send',
    'chain-after-send',
    'device-after-reopen',
    'link-on-reopen',
    'send-error'
  ])
    it(
      'orchestration rejects a broken send/reopen lifecycle without retry or fallback: ' +
        fault,
      async () => {
        const result = await orchestration(fault)
        const expected: Record<string, RegExp> = {
          'duplicate-peer': /must not duplicate/,
          'persisted-id': /msg_changed_persisted/,
          'lost-public-message': /Persisted public message is absent/,
          'public-key-after-send':
            /Observed installed replacement differs: boxPublicKey/,
          'roster-after-send': /cdv_unexpected/,
          'chain-after-send': /different-public-puk/,
          'device-after-reopen': /Installed-session key binding/,
          'link-on-reopen': /Unexpected linking fallback/,
          'send-error': /Public Send failed/
        }
        expect(String(result.error)).matches(expected[fault])
        expect(result.calls.filter(call => call === 'send')).deep.equals([
          'send'
        ])
        if (
          [
            'persisted-id',
            'lost-public-message',
            'device-after-reopen',
            'link-on-reopen'
          ].includes(fault)
        )
          expect(result.calls).includes('navigate-reopen')
        else expect(result.calls).not.includes('navigate-reopen')
        expect(result.calls).not.includes('case-passed')
        expect(result.calls).not.includes('forbidden-sign-in')
        expect(result.calls).not.includes('forbidden-link')
        expect(
          result.observations.some(
            row => row.postLifecycleWebContinuity === true
          )
        ).equals(false)
      }
    )
  it('orchestration rejects required login before old history or any send', async () => {
    const result = await orchestration('login-before-history')
    expect(String(result.error)).includes('login forbidden')
    expect(result.calls).not.includes('unchanged-legacy-oracles')
    expect(result.calls).not.includes('send')
    expect(result.calls).not.includes('forbidden-sign-in')
    expect(result.calls).not.includes('forbidden-link')
  })
})

describe('E5 exact touch quick-reaction toggle', () => {
  const viewer = userIdOfGumbo(1)
  const other = userIdOfGumbo(2)
  interface Reaction {
    emoji: string
    userIds: string[]
    mine?: boolean
  }
  async function run(options: {
    before: Reaction[]
    after: Reaction[]
    desktop?: boolean
    missingAfter?: boolean
    unavailableAfter?: boolean
    stalled?: boolean
  }): Promise<{
    error?: unknown
    calls: string[]
    observations: Array<Record<string, unknown>>
  }> {
    const calls: string[] = []
    let selected = false
    let postReads = 0
    let elapsed = 0
    const clock = Object.getOwnPropertyDescriptor(Date, 'now')!
    Object.defineProperty(Date, 'now', { ...clock, value: () => elapsed })
    const ui = {
      native: false,
      surface: options.desktop === true ? 'web-wide' : 'web-touch',
      metrics: () => ({ coarse: options.desktop !== true }),
      device: {
        dragAndDrop: async () => {
          calls.push('movement')
        },
        tapOn: async () => {
          calls.push('picker-tap')
        },
        inputText: async () => {
          calls.push('picker-query')
        }
      },
      absent: async (id: string) => {
        calls.push('absent:' + id)
      },
      text: async (text: string) => {
        calls.push('tap:' + text)
        if (text === '👍') selected = true
      },
      dom: async () => ({ publicHover: true })
    } as unknown as Chat2UI
    const peer = {
      engine: {
        open: async () => {
          if (selected) postReads++
          const late = selected && postReads > 1
          if (late) elapsed += 30001
          return {
            messages:
              late && options.missingAfter === true
                ? []
                : [
                    {
                      id: 'synthetic-target',
                      status:
                        late && options.unavailableAfter === true
                          ? 'unavailable'
                          : 'ok',
                      reactions:
                        selected && options.stalled !== true
                          ? options.after
                          : options.before
                    }
                  ]
          }
        }
      }
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      f: { messages: { target: { id: 'synthetic-target' } } },
      group: 'synthetic',
      viewerId: viewer,
      observations: [],
      check: async (name: string, work: () => Promise<void>) => {
        if (name.startsWith('E5 movement before hold')) await work()
      },
      anchor: async () => {},
      targetBounds: async () => ({ x: 48, y: 114, width: 273, height: 90 }),
      action: async () => {
        calls.push('exact-target-menu')
      },
      protocolPeer: async () => peer,
      pickThumbsUp: async () => {
        selected = true
        return '👍️'
      }
    }) as unknown as Scenarios
    let error: unknown
    try {
      await scenario.E5()
    } catch (failure) {
      error = failure
    } finally {
      Object.defineProperty(Date, 'now', clock)
    }
    return { error, calls, observations: scenario.observations }
  }
  it('accepts removal of the existing exact viewer quick glyph and keeps the VS16 sibling separate', async () => {
    const result = await run({
      before: [
        { emoji: '👍', userIds: [viewer], mine: false },
        { emoji: '👍️', userIds: [other], mine: true }
      ],
      after: [{ emoji: '👍️', userIds: [other], mine: true }]
    })
    expect(result.error).equals(undefined)
    expect(result.calls.filter(call => call === 'tap:👍')).has.length(1)
    expect(result.observations[0].actualQuickReactionToggle).deep.equals({
      messageId: 'synthetic-target',
      raw: '👍',
      viewerId: viewer,
      beforePresent: true,
      expectedAfterPresent: false
    })
  })
  it('accepts adding the exact viewer quick glyph when only another viewer had it', async () => {
    const result = await run({
      before: [{ emoji: '👍', userIds: [other], mine: true }],
      after: [{ emoji: '👍', userIds: [other, viewer] }]
    })
    expect(result.error).equals(undefined)
    expect(result.observations[0].actualQuickReactionToggle).deep.includes({
      beforePresent: false,
      expectedAfterPresent: true
    })
  })
  it('does not normalize a viewer VS16 glyph into the raw quick glyph', async () => {
    const result = await run({
      before: [{ emoji: '👍️', userIds: [viewer] }],
      after: [
        { emoji: '👍️', userIds: [viewer] },
        { emoji: '👍', userIds: [viewer] }
      ]
    })
    expect(result.error).equals(undefined)
  })
  for (const after of [
    [{ emoji: '👍️', userIds: [viewer] }],
    [{ emoji: '👍', userIds: [other] }]
  ])
    it('rejects a different raw glyph or another reacting viewer after addition', async () => {
      const result = await run({ before: [], after })
      expect(String(result.error)).includes(
        'Actual selected raw glyph and reacting viewer must reach the peer'
      )
    })
  it('rejects an unchanged existing viewer reaction after the removal tap', async () => {
    const own = [{ emoji: '👍', userIds: [viewer] }]
    const result = await run({ before: own, after: [], stalled: true })
    expect(String(result.error)).includes(
      'Actual selected raw glyph and reacting viewer must reach the peer'
    )
  })
  for (const fault of ['missingAfter', 'unavailableAfter'] as const)
    it(
      'does not accept target disappearance or unavailability as a successful removal: ' +
        fault,
      async () => {
        const result = await run({
          before: [{ emoji: '👍', userIds: [viewer] }],
          after: [],
          [fault]: true
        })
        expect(String(result.error)).includes(
          'Actual selected raw glyph and reacting viewer must reach the peer'
        )
      }
    )
  it('keeps full desktop picker addition even when the viewer already has the selected raw glyph', async () => {
    const own = [{ emoji: '👍️', userIds: [viewer] }]
    const result = await run({ before: own, after: own, desktop: true })
    expect(result.error).equals(undefined)
    expect(result.observations).has.length(0)
    expect(result.calls).includes('picker-query')
  })
})

describe('I2 descriptor-bound retained target session', () => {
  it('preserves valid descriptor modes and rejects malformed modes without changing non-I2 optional metadata', () => {
    const ordinary = { legacy: {}, fullWidthActors: [] }
    expect(asIdentityCompatibility(ordinary).i2Target).equals(undefined)
    for (const mode of ['retained-linked', 'new-empty'] as const)
      expect(
        asIdentityCompatibility({ ...ordinary, i2Target: mode }).i2Target
      ).equals(mode)
    expect(() =>
      asIdentityCompatibility({ ...ordinary, i2Target: 'relink' })
    ).throws()
  })
  function model(
    options: {
      mode?: 'retained-linked' | 'new-empty'
      surface?: 'web-wide' | 'web-narrow' | 'ios' | 'android'
      scenario?: 'I1' | 'I2'
      blocked?: string
      lateLink?: boolean
      wrongAccount?: boolean
    } = {}
  ): { scenario: Scenarios; calls: string[]; boundary: Error } {
    const calls: string[] = []
    const boundary = Error(
      'Actual expected account and conversation list reached'
    )
    let links = 0
    const actor = {
      email: 'willie@example.test',
      password: 'TEST_PASSWORD',
      accountLabel: 'Account, Willie Mays'
    }
    const ui = {
      scenario: options.scenario ?? 'I2',
      surface: options.surface ?? 'web-narrow',
      native: options.surface === 'ios' || options.surface === 'android',
      steps: [],
      open: async () => {
        calls.push('open')
      },
      back: async () => {
        calls.push('back')
      },
      visible: async (selector: Record<string, unknown>) => {
        const text = typeof selector.text === 'string' ? selector.text : ''
        if (text === '^Account,.*$') return true
        if (text.startsWith('^willie@')) return options.wrongAccount !== true
        if (text === '^Link this device$' || text === 'Link this device') {
          links++
          return (
            options.blocked === 'Link this device' ||
            (options.lateLink === true && links > 1)
          )
        }
        if (text === '^' + options.blocked + '$') return true
        return selector.id === 'chat-conversation-list'
      },
      present: async (id: string) => {
        calls.push(id)
        if (options.lateLink !== true) throw boundary
      },
      device: {
        tapOn: async () => {
          calls.push('account-menu')
        },
        assertVisible: async (selector: Record<string, unknown>) => {
          const label =
            typeof selector.text === 'string'
              ? selector.text
              : typeof selector.id === 'string'
                ? selector.id
                : ''
          calls.push('assert:' + label)
          if (options.mode === 'new-empty' && selector.text === '^Password$')
            throw boundary
          return {}
        },
        pressKey: async () => {
          throw Error('No password submission allowed')
        }
      },
      text: async () => {
        throw Error('No login or link tap allowed')
      },
      append: async () => {
        throw Error('No credential input allowed')
      }
    } as unknown as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      viewerKey: 'Willie',
      viewerId: userIdOfGumbo(9),
      observations: [],
      f: {
        actors: { Willie: actor },
        identityCompatibility: { i2Target: options.mode ?? 'retained-linked' }
      }
    }) as Scenarios
    return { scenario, calls, boundary }
  }
  for (const mode of [undefined, 'relink'])
    it(
      'fails closed before navigation for missing or invalid I2 target mode: ' +
        String(mode),
      async () => {
        const m = model()
        Object.assign(m.scenario.f.identityCompatibility!, { i2Target: mode })
        expect(String(await captureFailure(m.scenario.signIn()))).includes(
          'I2 target mode required'
        )
        expect(m.calls).has.length(0)
      }
    )
  for (const blocked of [
    'Sign in',
    'Password',
    'Link this device',
    'Reset chat'
  ])
    it(
      'rejects retained public ' + blocked + ' before any login or approval',
      async () => {
        const m = model({ blocked })
        expect(String(await captureFailure(m.scenario.signIn()))).includes(
          'Retained I2 target must already be signed in and linked'
        )
        expect(m.calls).deep.equals(['open'])
      }
    )
  for (const surface of ['web-narrow', 'ios', 'android'] as const)
    it(
      'requires the actual retained account and list without password fallback on ' +
        surface,
      async () => {
        const m = model({ surface })
        expect(await captureFailure(m.scenario.signIn())).equals(m.boundary)
        expect(m.calls).includes('assert:^Account, Willie Mays$')
        expect(m.calls).includes('chat-conversation-list')
        expect(m.scenario.ui.steps).has.length(0)
      }
    )
  it('rejects a Link that appears after the retained session gate', async () => {
    const m = model({ lateLink: true })
    expect(String(await captureFailure(m.scenario.signIn()))).includes(
      'retained I2 target must not request another device link'
    )
    expect(
      m.scenario.observations.some(row => row.browserLinkApproval != null)
    ).equals(false)
  })
  it('retains account replacement rejection for a wrong retained actor', async () => {
    const m = model({ wrongAccount: true })
    expect(String(await captureFailure(m.scenario.signIn()))).includes(
      'account replacement is prohibited'
    )
    expect(m.calls).not.includes('chat-conversation-list')
  })
  it('leaves the explicit new wide target on the ordinary password path', async () => {
    const m = model({
      mode: 'new-empty',
      surface: 'web-wide',
      blocked: 'Password'
    })
    expect(await captureFailure(m.scenario.signIn())).equals(m.boundary)
    expect(m.scenario.ui.steps).has.length(1)
    expect(m.calls).includes('assert:^Password$')
  })
  it('refuses a new-empty descriptor on a retained narrow target', async () => {
    const m = model({ mode: 'new-empty', surface: 'web-narrow' })
    expect(String(await captureFailure(m.scenario.signIn()))).includes(
      'Only an explicit new wide target may link'
    )
    expect(m.calls).has.length(0)
  })
  it('keeps the original I1 Link rejection independent of I2 descriptor mode', async () => {
    const m = model({ scenario: 'I1', lateLink: true })
    expect(String(await captureFailure(m.scenario.signIn()))).includes(
      'must not request another device link'
    )
    expect(
      m.scenario.observations.some(row => row.browserLinkApproval != null)
    ).equals(false)
  })
})

describe('E3 autofocus proof before targeted composer entry', function () {
  function model(
    surface: 'ios' | 'android' | 'web-wide' = 'ios',
    fault = ''
  ): {
    scenario: Scenarios
    calls: string[]
    inputs: Array<Record<string, unknown>>
    stop: Error
    failed: Error
  } {
    const calls: string[] = []
    const inputs: Array<Record<string, unknown>> = []
    const stop = Error('Original E3 first attachment boundary')
    const failed = Error('Actual pre-input proof failed: ' + fault)
    let reply = false
    let keyboardComplete = false
    let captured = false
    const native = surface !== 'web-wide'
    const ui = Object.assign(Object.create(Chat2UI.prototype), {
      surface,
      native,
      steps: [],
      metrics: () => ({ coarse: false }),
      replaceDraft: async (text: string) => {
        expect(text).equals('')
        calls.push('prepare-empty-draft')
      },
      assertKeyboard: async () => {
        expect(reply).equals(true)
        calls.push('keyboard-check')
        if (fault === 'keyboard') throw failed
        calls.push('keyboard-image')
        if (fault === 'keyboard-image') throw failed
        keyboardComplete = true
      },
      shot: async (kind: string) => {
        expect(kind).equals('reply-keyboard')
        expect(keyboardComplete).equals(true)
        calls.push('pre-input-capture')
        if (fault === 'capture') throw failed
        captured = true
      },
      device: {
        tapOn: async (args: Record<string, unknown>) => {
          expect(args).deep.equals({ text: '^Reply$' })
          calls.push('explicit-reply')
          reply = true
        },
        assertVisible: async (args: Record<string, unknown>) => {
          expect(args.text).equals('^Cancel reply$')
          expect(reply).equals(true)
          calls.push('reply-context')
          if (fault === 'reply-context') throw failed
        },
        inputText: async (args: Record<string, unknown>) => {
          expect(
            reply && keyboardComplete && captured,
            'No input or its driver focus tap before all pre-input proof succeeds'
          ).equals(true)
          inputs.push(args)
          calls.push('text-entry')
          if (fault === 'input') throw failed
          if (surface === 'ios' && args.id !== 'chat-composer')
            throw Error(
              'Stale Reply button remains the input verification target'
            )
          expect(args.text).matches(
            /^Explicit reply with synthetic photo \d{13}$/
          )
        }
      }
    }) as Chat2UI
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      observations: [],
      f: { messages: { target: { id: 'msg-reply-fixture' } } },
      check: async (_name: string, work: () => Promise<void>) => {
        await work()
      },
      openGroup: async () => {
        calls.push('open-group')
      },
      anchor: async () => {
        calls.push('anchor')
      },
      action: async () => {
        calls.push('reply-action')
        if (!native) reply = true
      },
      attachPhoto: async () => {
        calls.push('original-attachment-boundary')
        expect(inputs).has.length(1)
        throw stop
      }
    }) as Scenarios
    return { scenario, calls, inputs, stop, failed }
  }

  it('uses the exact iOS composer only after original Reply keyboard proof and capture', async () => {
    const m = model()
    expect(await captureFailure(m.scenario.E3())).equals(m.stop)
    expect(m.calls).deep.equals([
      'open-group',
      'anchor',
      'prepare-empty-draft',
      'reply-action',
      'explicit-reply',
      'reply-context',
      'keyboard-check',
      'keyboard-image',
      'pre-input-capture',
      'text-entry',
      'original-attachment-boundary'
    ])
    expect(m.inputs).has.length(1)
    expect(m.inputs[0].id).equals('chat-composer')
    expect(Object.keys(m.inputs[0]).sort()).deep.equals(['id', 'text'])
  })

  for (const fault of [
    'reply-context',
    'keyboard',
    'keyboard-image',
    'capture'
  ])
    it(
      'does not target or type into composer after failed pre-input proof: ' +
        fault,
      async () => {
        const m = model('ios', fault)
        expect(await captureFailure(m.scenario.E3())).equals(m.failed)
        expect(m.inputs).deep.equals([])
        expect(m.calls).not.includes('text-entry')
        expect(m.calls).not.includes('original-attachment-boundary')
      }
    )

  it('propagates a genuine targeted-input failure instead of treating it as autofocus success', async () => {
    const m = model('ios', 'input')
    expect(await captureFailure(m.scenario.E3())).equals(m.failed)
    expect(m.calls.indexOf('text-entry')).greaterThan(
      m.calls.indexOf('pre-input-capture')
    )
    expect(m.calls).not.includes('original-attachment-boundary')
  })

  for (const surface of ['android', 'web-wide'] as const)
    it(
      'retains original non-iOS input semantics after the same proof boundary: ' +
        surface,
      async () => {
        const m = model(surface)
        expect(await captureFailure(m.scenario.E3())).equals(m.stop)
        expect(m.inputs).has.length(1)
        expect(m.inputs[0]).not.have.property('id')
        if (surface === 'android') expect(m.inputs[0].keyPress).equals(true)
        else expect(Object.keys(m.inputs[0])).deep.equals(['text'])
        expect(m.calls.indexOf('text-entry')).greaterThan(
          m.calls.indexOf('pre-input-capture')
        )
      }
    )
})

describe('web large-text zoomed control captures', function () {
  interface Box {
    x: number
    y: number
    width: number
    height: number
  }
  function model(
    options: {
      pannedCancel?: Box
      scaleAfterReveal?: number
      hidden?: boolean
      unfocused?: boolean
      deadline?: number
    } = {}
  ): {
    scenario: Scenarios
    shots: string[]
    reveals: string[]
    observations: Array<Record<string, unknown>>
  } {
    const page = new JSDOM(
      '<div data-testid="chat-picker-header"><span>Mention a member</span>' +
        '<button>Cancel</button></div><div data-testid="chat-picker-content">' +
        '<input aria-label="Search members"></div>',
      { runScripts: 'outside-only', pretendToBeVisual: true }
    )
    const window = page.window
    const document = window.document
    const viewport = {
      offsetLeft: 0,
      offsetTop: 0,
      width: 960,
      height: 666.667,
      scale: 1.5
    }
    Object.defineProperty(window, 'visualViewport', { value: viewport })
    Object.defineProperty(window, 'innerWidth', { value: 1440 })
    Object.defineProperty(window, 'innerHeight', { value: 1000 })
    Object.defineProperty(window, 'devicePixelRatio', { value: 2 })
    const boxes = new Map<Element, Box>()
    const heading = document.querySelector('span')!
    const cancel = document.querySelector('button')!
    const search = document.querySelector('input')!
    boxes.set(heading, { x: 24, y: 16, width: 220, height: 30 })
    boxes.set(cancel, { x: 1320, y: 12, width: 96, height: 40 })
    boxes.set(search, { x: 24, y: 70, width: 1377, height: 48 })
    for (const node of boxes.keys())
      Object.defineProperty(node, 'getBoundingClientRect', {
        value: () => {
          const b = boxes.get(node)!
          return {
            ...b,
            left: b.x,
            top: b.y,
            right: b.x + b.width,
            bottom: b.y + b.height
          }
        }
      })
    if (options.hidden === true) cancel.setAttribute('aria-hidden', 'true')
    if (options.unfocused !== true) search.focus()
    const reveals: string[] = []
    Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
      value(this: Element) {
        reveals.push(this.textContent ?? '')
        if (options.pannedCancel != null && this === cancel)
          boxes.set(cancel, options.pannedCancel)
        if (options.scaleAfterReveal != null)
          viewport.scale = options.scaleAfterReveal
      }
    })
    const shots: string[] = []
    const ui = {
      native: false,
      deadline: AbortSignal.timeout(options.deadline ?? 10000),
      dom: async (script: string) =>
        JSON.parse(
          JSON.stringify(window.eval('(()=>{' + script + '})()'))
        ) as Record<string, unknown>,
      shot: async (kind: string) => {
        shots.push(kind)
      }
    }
    const observations: Array<Record<string, unknown>> = []
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui,
      observations
    }) as Scenarios
    return { scenario, shots, reveals, observations }
  }
  const headingSearch = [
    {
      name: 'heading',
      css: '[data-testid="chat-picker-header"] *',
      text: 'Mention a member'
    },
    {
      name: 'search',
      css: '[data-testid="chat-picker-content"] [aria-label="Search members"]'
    }
  ]
  const cancelTarget = [
    {
      name: 'cancel',
      css: '[data-testid="chat-picker-header"] button',
      text: 'Cancel'
    }
  ]

  it('captures heading and focused Search already inside the visual viewport', async () => {
    const actual = model()
    await actual.scenario.zoomedWebControlShot('zoom-left', headingSearch, '')
    expect(actual.shots).deep.equals(['zoom-left'])
    expect(actual.reveals).deep.equals([])
    expect(actual.observations[0]).includes({ outcome: 'passed' })
  })

  it('reveals an off-frame Cancel publicly and captures only once it is framed', async () => {
    const actual = model({
      pannedCancel: { x: 700, y: 12, width: 96, height: 40 }
    })
    await actual.scenario.zoomedWebControlShot('zoom-right', cancelTarget, '')
    expect(actual.reveals).deep.equals(['Cancel'])
    expect(actual.shots).deep.equals(['zoom-right'])
    expect(actual.observations[0].revealed).deep.equals(['cancel'])
  })

  it('fails without a capture when an ordinary reveal leaves Cancel outside the view', async () => {
    const actual = model({ deadline: 400 })
    const error = await captureFailure(
      actual.scenario.zoomedWebControlShot('zoom-right', cancelTarget, '')
    )
    expect(String(error)).matches(/abort|timeout/i)
    expect(actual.reveals).deep.equals(['Cancel'])
    expect(actual.shots).deep.equals([])
    expect(actual.observations[0]).includes({ outcome: 'failed' })
  })

  it('refuses a reveal that changes the actual zoom', async () => {
    const actual = model({ scaleAfterReveal: 1 })
    const error = await captureFailure(
      actual.scenario.zoomedWebControlShot('zoom-right', cancelTarget, '')
    )
    expect(String(error)).includes(
      'Control reveal must preserve actual zoom and viewport dimensions'
    )
    expect(actual.shots).deep.equals([])
  })

  it('refuses a hidden control instead of revealing it', async () => {
    const actual = model({ hidden: true })
    const error = await captureFailure(
      actual.scenario.zoomedWebControlShot('zoom-right', cancelTarget, '')
    )
    expect(String(error)).includes('Visible enabled zoom control required')
    expect(actual.reveals).deep.equals([])
  })

  it('reveals an unfocused editor before its tap without taking a capture', async () => {
    const actual = model({ unfocused: true })
    await actual.scenario.revealZoomedWebControl('zoom-reveal', {
      name: 'search',
      css: '[data-testid="chat-picker-content"] [aria-label="Search members"]',
      requireFocus: false
    })
    expect(actual.shots).deep.equals([])
    expect(actual.observations[0]).includes({ outcome: 'passed' })
  })

  it('does not accept a Search editor without its actual focus', async () => {
    const actual = model({ unfocused: true, deadline: 400 })
    const error = await captureFailure(
      actual.scenario.zoomedWebControlShot('zoom-left', headingSearch, '')
    )
    expect(String(error)).matches(/abort|timeout/i)
    expect(actual.shots).deep.equals([])
  })
})
