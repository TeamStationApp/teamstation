import { type ChildProcess, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { transform } from 'sucrase'

import {
  Chat2UI,
  iosPublicRead,
  type PublicNode
} from '../../test/chat2Maestro.e2e'
import { backdropOf } from '../components/glassBackdrop'
import type { GlassViewProps } from '../components/glassViewProps'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import {
  compareIosComposerFrames,
  iosSpotlightCaptureGeometry,
  observeComposerCaptureReady,
  observeInfoCaptureReady,
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
  rawPairStable?: boolean
  rawPairStableForMs?: number
  rawFrames?: Array<{
    sha256: string
    path: string
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
  afterEach(() => {
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
      group: 'synthetic'
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
            messages: [{ id: 'synthetic-target', reactions: [{ emoji: '👍' }] }]
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
