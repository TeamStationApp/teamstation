import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isIosWebKit } from './iosWebKit'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1'
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1'
const IPOD =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

describe('isIosWebKit', () => {
  it('knows an iPhone, an iPad and an iPod by their user agents', () => {
    for (const userAgent of [IPHONE, IPAD, IPOD])
      expect(isIosWebKit({ userAgent, maxTouchPoints: 5 })).equals(true)
  })

  it('knows an iPad asking for the desktop site by its touch screen', () => {
    expect(isIosWebKit({ userAgent: MAC, maxTouchPoints: 5 })).equals(true)
    expect(isIosWebKit({ userAgent: MAC, maxTouchPoints: 0 })).equals(false)
  })

  it('is false on Android, a desktop browser and without a navigator', () => {
    expect(isIosWebKit({ userAgent: ANDROID, maxTouchPoints: 5 })).equals(false)
    expect(isIosWebKit({ userAgent: CHROME, maxTouchPoints: 0 })).equals(false)
    expect(isIosWebKit(undefined)).equals(false)
  })

  it('is false for React Native’s navigator, which has no user agent', () => {
    expect(isIosWebKit({})).equals(false)
  })
})
