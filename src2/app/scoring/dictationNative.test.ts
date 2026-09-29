import { expect } from 'chai'
import { describe, it } from 'mocha'

import { useDictationControls } from './DictationButton.native'
import type { DictationButtonProps } from './dictationTypes'
import { dictationUrl, useDictation } from './useDictation.native'

describe('dictation on the phone', function () {
  it('shows no control and does nothing, since the phone has no web microphone', function () {
    const props = {} as unknown as DictationButtonProps
    expect(useDictationControls(props)).deep.equals({
      control: null,
      log: null
    })
    const dictation = useDictation(props)
    expect(dictation).deep.include({
      enabled: false,
      connected: false,
      holding: false,
      busy: false,
      text: null,
      message: null,
      ask: null
    })
    for (const call of [
      () => {
        dictation.setEnabled(true)
      },
      dictation.hold,
      dictation.release,
      () => {
        dictation.answer(0)
      },
      dictation.dismiss
    ])
      expect(call).not.throws()
    expect(useDictation(props).enabled).equals(false)
    expect(dictationUrl('/api/v1')).equals('')
  })
})
