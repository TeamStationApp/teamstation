import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { VideoView } from './VideoView.native'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

/** What `VideoView.native` handed the phone's player. */
async function handed(
  props: Partial<React.ComponentProps<typeof VideoView>>
): Promise<Record<string, unknown>> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <VideoView
        source="https://media.example.test/v1/index.m3u8"
        onHandle={() => undefined}
        {...props}
      />
    )
  })
  const node = document.querySelector('[data-video-props]')!
  return JSON.parse(node.getAttribute('data-video-props')!) as Record<
    string,
    unknown
  >
}

describe("the phone's picture and its audio session (U33a)", function () {
  it('takes the session through the silent switch when primary, with no controls', async function () {
    const props = await handed({ controls: false, primary: true })
    expect(props.controls).equals(false)
    expect(props.disableFocus).equals(false)
    expect(props.ignoreSilentSwitch).equals('ignore')
    // The app's own live pill, never ExoPlayer's badge as well.
    expect(props.controlsStyles).deep.equals({ hideLiveBadge: true })
  })

  it('leaves the session alone, obeying the switch, when not', async function () {
    const props = await handed({ controls: false, primary: false })
    expect(props.disableFocus).equals(true)
    expect(props.ignoreSilentSwitch).equals('obey')
    // A card's preview, which says neither, is not primary.
    const preview = await handed({})
    expect(preview.disableFocus).equals(true)
  })
})
