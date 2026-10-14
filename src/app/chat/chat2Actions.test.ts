import { type ChildProcess, spawnSync } from 'node:child_process'
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

import {
  CHAT2_SCENARIOS,
  type Chat2Fixture,
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
      message({ id: 'msg_c', senderUserId: 3 }),
      message({ id: 'msg_d', senderUserId: 3, mine: true }),
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
    attached = false
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
      mode === 'dynamic-empty-name' || mode === 'raw-empty-name'
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
        mode === 'raw' ||
        mode === 'raw-empty-name' ||
        (mode === 'literal-placeholder-after' &&
          sentinelTyped &&
          value === 'Message')
      )
        nodes.push(
          node(2, 'TextView', {
            identifier: 'chat-composer',
            label: value === '' ? emptyName() : 'Message',
            placeholderValue: 'Message',
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
      if (args.text === '7777') sentinelTyped = true
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
      actual.device.eraseText = async () => {
        calls.push('erase')
      }
      actual.device.inputText = async args => {
        calls.push(['type', args])
        value = String(args.text)
      }
      let value = ''
      actual.draft = async () => value
      await actual.replaceDraft('Exact\ntext')
      expect(calls).deep.equals([
        ['focus', { id: 'chat-composer' }],
        'erase',
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
      authorId: 2,
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
      viewerId: 1,
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
      senderUserId: 2,
      mine: true,
      body: 'First incoming row'
    })
    const end = message({
      id: 'run-last',
      seq: 2,
      senderUserId: 2,
      mine: true,
      body: 'Final incoming row'
    })
    const boundary = message({
      id: 'own-boundary',
      seq: 3,
      senderUserId: 1,
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
      viewerId: 1,
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
      authorId: 2
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
        authorId: 2
      })
    )
    const model = incomingModel()
    const reserved = await model.scenario.incomingReservation({
      id: 'run-first',
      seq: 1,
      body: 'First row',
      authorId: 2
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
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      group: 'conversation',
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
    expect(tapped).deep.equals([{ point: '110,40' }])
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
    expect(tapped).deep.equals([{ point: '270,470' }])
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
    actual.absent = async id => {
      calls.push(id)
    }
    actual.text = async () => {}
    actual.device.dragAndDrop = async args => {
      calls.push(args)
    }
    const scenario = Object.assign(Object.create(Scenarios.prototype), {
      ui: actual,
      f: { messages: { target: { id: 'synthetic-target' } } },
      group: 'synthetic',
      viewerId: 1
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
                reactions: [{ emoji: '👍', userIds: [1] }]
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
      { emoji: '👍️', userIds: [1] },
      { emoji: '👍', userIds: [2] }
    ]) {
      const actual = ui([])
      actual.absent = async () => {}
      actual.text = async () => {}
      actual.device.dragAndDrop = async () => {}
      const scenario = Object.assign(Object.create(Scenarios.prototype), {
        ui: actual,
        f: { messages: { target: { id: 'synthetic-target' } } },
        group: 'synthetic',
        viewerId: 1
      }) as Scenarios
      scenario.check = async (name, work) => {
        if (name.startsWith('E5 movement before hold')) await work()
      }
      scenario.anchor = async () => {}
      scenario.targetBounds = async () => box
      scenario.action = async () => {}
      const peer = {
        engine: {
          open: async () => ({
            messages: [{ id: 'synthetic-target', reactions: [reaction] }]
          })
        }
      }
      scenario.protocolPeer = async () =>
        peer as unknown as Awaited<ReturnType<Scenarios['protocolPeer']>>
      expect(String(await captureFailure(scenario.E5()))).contains(
        'Actual selected raw glyph and reacting viewer'
      )
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
      expect(options).deep.equals({ block: 'center' })
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
      viewerId: 9,
      f: {
        members: [
          { userId: 1, name: 'Same', role: '' },
          { userId: 2, name: 'Same', role: '' },
          { userId: 3, name: 'Unique', role: 'Member' }
        ]
      },
      observations: []
    }) as Scenarios
    const selected = await scenario.showInfoMember()
    expect(selected.userId).equals(3)
    expect(selectors[0]).deep.equals({ text: '^Safety number with Unique$' })
    expect(selectors[1]).deep.equals([
      {
        text: '^Safety number with Unique$',
        childOf: { id: 'chat-info-members' }
      },
      'Button'
    ])
  })
  it('routes measured browser gestures through supported endpoints and native gestures through swipe', async () => {
    for (const surface of ['ios', 'android', 'web-wide']) {
      const actual = ui([], surface)
      const calls: unknown[] = []
      actual.device.swipe = async args => {
        calls.push(['swipe', args])
      }
      actual.device.dragAndDrop = async args => {
        calls.push(['drag', args])
      }
      await actual.measuredSwipe({
        startX: 10,
        startY: 20,
        endX: 40,
        endY: 50,
        duration: 200
      })
      expect(calls).deep.equals(
        surface === 'web-wide'
          ? [
              [
                'drag',
                {
                  from: { point: '10,20' },
                  to: { point: '40,50' },
                  holdDuration: 1,
                  duration: 200
                }
              ]
            ]
          : [
              [
                'swipe',
                { startX: 10, startY: 20, endX: 40, endY: 50, duration: 200 }
              ]
            ]
      )
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
      actors: { viewer: { userId: 1, provider: { sessionFile } } }
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
  } {
    const { actual, page } = browserModel()
    actual.metrics = () => ({ width: 300, height: 600, dpr: 1, coarse: false })
    page.window.document.body.innerHTML =
      '<button id="pins">Pins</button><div data-testid="chat-message-target"><div data-testid="chat-bubble-target">Synthetic body</div><button role="button" aria-label="More message actions">More</button></div><textarea data-testid="chat-composer">Unsent draft</textarea>'
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
    return { scenario, calls, actual }
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
      viewerId: 9,
      f: { members: [{ userId: 3, name: 'Unique', role: 'Member' }] },
      observations: []
    }) as Scenarios
    const selected = await scenario.showInfoMember()
    expect(selected.userId).equals(3)
    expect(gestures).deep.equals([])
    expect(scenario.observations[0]).deep.includes({
      infoMemberFraming: {
        userId: 3,
        selector: { text: '^Safety number with Unique$' },
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
      viewerId: 9,
      f: { members: [{ userId: 3, name: 'Unique', role: 'Member' }] },
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
