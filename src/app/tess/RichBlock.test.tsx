import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { View } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  render,
  rerender,
  unmount
} from '../../test/tessTestKit'
import { RICH_PREVIEW_HEIGHT, RichBlock } from './RichBlock'
import { RICH_POLICY } from './richDocument'
import {
  TessOverlayHost,
  TessOverlayProvider,
  type TessOverlaySlot,
  useTessOverlay
} from './TessOverlay'

const TABLE = '<table><tr><th>Team</th></tr><tr><td>Comets</td></tr></table>'

function frames(): HTMLIFrameElement[] {
  return [...document.body.querySelectorAll('iframe')]
}

describe('RichBlock', function () {
  afterEach(async () => {
    await unmount()
  })

  it('previews the HTML in a sandboxed frame without scripts, under the policy', async function () {
    await render(<RichBlock html={TABLE} />)
    const card = byTestId('Tess rich block')!
    expect(getComputedStyle(card).height).equals(`${RICH_PREVIEW_HEIGHT}px`)
    const [frame] = frames()
    expect(frame.getAttribute('sandbox')).equals('')
    expect(frame.getAttribute('sandbox')).not.includes('allow-scripts')
    expect(frame.style.pointerEvents).equals('none')
    expect(frame.getAttribute('tabindex')).equals('-1')
    const source = frame.getAttribute('srcdoc')!
    expect(source).includes(`content="${RICH_POLICY}"`)
    expect(source).includes('<td>Comets</td>')
  })

  it('opens full screen on a tap, scrollable, and the X closes it', async function () {
    await render(<RichBlock html={TABLE} />)
    await click(byLabel('Open full screen'))
    const viewer = byTestId('Tess rich viewer')!
    expect(viewer).not.equals(null)
    const full = frames().find(frame => viewer.contains(frame))!
    expect(full.style.pointerEvents).equals('auto')
    expect(full.getAttribute('tabindex')).equals('0')
    expect(full.getAttribute('sandbox')).equals('')
    await click(byLabel('Close'))
    expect(byTestId('Tess rich viewer')).equals(null)
    expect(frames().length).equals(1)
  })

  it('opens over the pane, into the overlay host, when the Shell provides one', async function () {
    await render(
      <TessOverlayProvider>
        <View testID="chat">
          <RichBlock html={TABLE} />
        </View>
        <View testID="pane">
          <TessOverlayHost />
        </View>
      </TessOverlayProvider>
    )
    expect(byTestId('Tess overlay')).equals(null)
    await click(byLabel('Open full screen'))
    const overlay = byTestId('Tess overlay')!
    expect(byTestId('pane')!.contains(overlay)).equals(true)
    expect(getComputedStyle(overlay).position).equals('absolute')
    expect(
      overlay.querySelector('[data-testid="Tess rich viewer"]')
    ).not.equals(null)
    expect(
      byTestId('chat')!.querySelector('[data-testid="Tess rich viewer"]')
    ).equals(null)
    // The chat stays usable: its card can still be pressed.
    expect(
      byTestId('chat')!.querySelector('[aria-label="Open full screen"]')
    ).not.equals(null)
    await click(byLabel('Close'))
    expect(byTestId('Tess overlay')).equals(null)
  })

  it('takes the layer down when the block leaves, and only its own', async function () {
    let show = true
    const view = (): React.ReactElement => (
      <TessOverlayProvider>
        {show && <RichBlock html={TABLE} />}
        <RichBlock html="<svg></svg>" />
        <TessOverlayHost />
      </TessOverlayProvider>
    )
    await render(view())
    const [first, second] = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[aria-label="Open full screen"]'
      )
    ]
    await click(first)
    await click(second)
    const overlay = byTestId('Tess overlay')!
    expect(overlay.querySelector('iframe')!.getAttribute('srcdoc')).includes(
      '<svg></svg>'
    )
    show = false
    await rerender(view())
    expect(
      byTestId('Tess overlay')!.querySelector('iframe')!.getAttribute('srcdoc')
    ).includes('<svg></svg>')
  })

  it('closes the open viewer through its card when the slot is dismissed', async function () {
    let slot: TessOverlaySlot | null = null
    const Reader = (): null => {
      slot = useTessOverlay()
      return null
    }
    await render(
      <TessOverlayProvider>
        <Reader />
        <RichBlock html={TABLE} />
        <TessOverlayHost />
      </TessOverlayProvider>
    )
    // Nothing open: nothing to close.
    await act(async () => {
      slot!.dismiss()
    })
    expect(byTestId('Tess overlay')).equals(null)
    await click(byLabel('Open full screen'))
    expect(byTestId('Tess overlay')).not.equals(null)
    await act(async () => {
      slot!.dismiss()
    })
    expect(byTestId('Tess overlay')).equals(null)
    // The card knows it closed, so a tap opens it again.
    await click(byLabel('Open full screen'))
    expect(byTestId('Tess rich viewer')).not.equals(null)
  })
})
