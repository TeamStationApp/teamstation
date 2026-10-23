/* eslint-disable @typescript-eslint/unbound-method -- The test swaps an AccessibilityInfo function and puts it back. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { AccessibilityInfo } from 'react-native'

import {
  byLabel,
  byTestId,
  type ManualClock,
  manualClock,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { tsBallpark } from '../theme/tsBallpark'
import { HOLD_MS, HoldToConfirm, pillPerimeter } from './HoldToConfirm'

let clock: ManualClock | undefined
let restoreMotion: (() => void) | undefined

/** The system's Reduce Motion setting, switched on. */
function reduceMotion(): void {
  const original = AccessibilityInfo.isReduceMotionEnabled
  AccessibilityInfo.isReduceMotionEnabled = async () => true
  restoreMotion = () => {
    AccessibilityInfo.isReduceMotionEnabled = original
  }
}

/** A press starts 50 ms after the pointer goes down, on the real clock. */
async function pointer(type: 'mousedown' | 'mouseup'): Promise<void> {
  await act(async () => {
    byLabel('Hold to confirm').dispatchEvent(
      new window.MouseEvent(type, { bubbles: true, button: 0 })
    )
    await new Promise(resolve => setTimeout(resolve, 80))
  })
}

function trace(): Element {
  const rect = byTestId('Tess hold')!.querySelectorAll('rect')[1]
  expect(rect, 'the trace').not.equals(undefined)
  return rect
}

/** How much of the outline is drawn, from 0 to 1. */
function traced(): number {
  const rect = trace()
  const perimeter = Number(
    rect.getAttribute('stroke-dasharray')!.split(/[ ,]+/)[0]
  )
  return 1 - Number(rect.getAttribute('stroke-dashoffset')) / perimeter
}

async function holdButton(): Promise<{ confirms: number[] }> {
  const confirms: number[] = []
  clock = manualClock()
  await render(<HoldToConfirm onConfirm={() => confirms.push(1)} />)
  await settle()
  return { confirms }
}

describe('HoldToConfirm', function () {
  afterEach(async () => {
    await unmount()
    clock?.restore()
    clock = undefined
    restoreMotion?.()
    restoreMotion = undefined
  })

  it('draws the outline as a pill: a rect whose corner radius is half its height', async function () {
    await holdButton()
    const rect = trace()
    const height = Number(rect.getAttribute('height'))
    const width = Number(rect.getAttribute('width'))
    expect(Number(rect.getAttribute('rx'))).equals(height / 2)
    expect(Number(rect.getAttribute('ry'))).equals(height / 2)
    expect(height).closeTo(tsBallpark.rem(3) - 3, 0.001)
    expect(
      Number(rect.getAttribute('stroke-dasharray')!.split(/[ ,]+/)[0])
    ).closeTo(pillPerimeter(width, height), 0.001)
    expect(traced()).closeTo(0, 0.001)
  })

  it('runs nothing when released at 2,900 ms, and wipes the trace', async function () {
    const { confirms } = await holdButton()
    await pointer('mousedown')
    expect(clock!.pending()).includes(HOLD_MS)
    await clock!.advance(2900)
    await pointer('mouseup')
    expect(confirms).deep.equals([])
    expect(clock!.pending()).deep.equals([])
    expect(traced()).closeTo(0, 0.001)
    await clock!.advance(1000)
    expect(confirms).deep.equals([])
  })

  it('runs once after a 3,000 ms hold, and keeps the trace full', async function () {
    const { confirms } = await holdButton()
    await pointer('mousedown')
    await clock!.advance(2999)
    expect(confirms).deep.equals([])
    await clock!.advance(1)
    expect(confirms).deep.equals([1])
    expect(traced()).closeTo(1, 0.001)
    await pointer('mouseup')
    await clock!.advance(5000)
    expect(confirms).deep.equals([1])
    expect(traced()).closeTo(1, 0.001)
  })

  it('resets when the press is taken away', async function () {
    const { confirms } = await holdButton()
    await pointer('mousedown')
    await clock!.advance(1500)
    expect(traced()).greaterThan(0)
    // The page's context menu takes the press away from the button.
    await act(async () => {
      byLabel('Hold to confirm').dispatchEvent(
        new window.Event('contextmenu', { bubbles: true })
      )
    })
    expect(clock!.pending()).deep.equals([])
    expect(traced()).closeTo(0, 0.001)
    await clock!.advance(3000)
    expect(confirms).deep.equals([])
    expect(traced()).closeTo(0, 0.001)
  })

  it('with reduced motion still takes three seconds, drawn a quarter at a time', async function () {
    reduceMotion()
    const { confirms } = await holdButton()
    await pointer('mousedown')
    await clock!.advance(749)
    expect(traced()).closeTo(0, 0.001)
    await clock!.advance(1)
    expect(traced()).closeTo(0.25, 0.001)
    await clock!.advance(750)
    expect(traced()).closeTo(0.5, 0.001)
    await clock!.advance(750)
    expect(traced()).closeTo(0.75, 0.001)
    expect(confirms).deep.equals([])
    await clock!.advance(750)
    expect(traced()).closeTo(1, 0.001)
    expect(confirms).deep.equals([1])
  })

  it('says Confirming… and takes no hold while the change runs', async function () {
    const confirms: number[] = []
    clock = manualClock()
    await render(<HoldToConfirm busy onConfirm={() => confirms.push(1)} />)
    const button = byLabel('Confirming…')
    expect(button.textContent).equals('Confirming…')
    await act(async () => {
      button.dispatchEvent(
        new window.MouseEvent('mousedown', { bubbles: true })
      )
    })
    expect(clock.pending()).deep.equals([])
    await clock.advance(HOLD_MS)
    expect(confirms).deep.equals([])
  })
})
