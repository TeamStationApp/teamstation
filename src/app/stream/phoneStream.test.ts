import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import {
  phoneStream,
  PhoneStreamPreview,
  usePhoneStreamStatus,
  useRadarState,
  useRecordings
} from './phoneStream'

describe('phone streaming in a browser', function () {
  it('reports unsupported, so no Record video is offered', async function () {
    expect(await phoneStream.capabilities()).deep.equals({
      supported: false,
      deviceModel: ''
    })
    try {
      await phoneStream.open('Home Plate')
      expect.fail('open resolved')
    } catch (error) {
      expect(error).to.include({ code: 'unsupported' })
    }
  })

  it('draws no preview, and its hooks hold nothing', function () {
    const seen: unknown[] = []
    function Probe(): null {
      seen.push(
        usePhoneStreamStatus(),
        useRadarState(),
        useRecordings().recordings
      )
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => {
      root.render(createElement(Probe))
    })
    act(() => {
      root.unmount()
    })
    expect(seen.slice(0, 3)).deep.equals([null, null, []])
    expect(PhoneStreamPreview({ mirrored: true })).equals(null)
  })
})
