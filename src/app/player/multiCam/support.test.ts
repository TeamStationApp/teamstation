import { expect } from 'chai'
import { describe, it } from 'mocha'

import { engineOf } from '../controlGeometry'
import { multiAngleSupported } from './support'

const agents: Record<string, string> = {
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1',
  iPhoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  iPhoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  iPadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
}

describe('where the multi-camera grid is offered', function () {
  it('is not offered in Safari, nor in any browser on an iPhone or iPad', function () {
    for (const name of [
      'iPhoneSafari',
      'iPhoneChrome',
      'iPhoneFirefox',
      'iPadSafari',
      'macSafari'
    ]) {
      expect(multiAngleSupported(engineOf(agents[name])), name).equals(false)
    }
  })

  it('is offered in Chrome, Edge and Brave elsewhere, and in both apps', function () {
    for (const name of ['macChrome', 'windowsEdge', 'androidChrome']) {
      expect(multiAngleSupported(engineOf(agents[name])), name).equals(true)
    }
    expect(multiAngleSupported('avplayer')).equals(true)
    expect(multiAngleSupported('exoplayer')).equals(true)
  })
})
