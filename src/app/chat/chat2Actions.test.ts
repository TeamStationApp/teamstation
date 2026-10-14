import { expect } from 'chai'
import { describe, it } from 'mocha'

import { endsIncomingRun } from './chatMessageRuns'
import { captureMessageBounds } from './chatMessageSource'
import { spotlightLayout } from './chatSpotlightModel'
import { message } from './chatViews.test.helpers'

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
