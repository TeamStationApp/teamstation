import { expect } from 'chai'

import { addressIsWrong } from './videoError'

/** The shape `react-native-video` hands up, with only what is read here. */
const failure = (detail: unknown): never => detail as never

describe('addressIsWrong', function () {
  it('knows an expired playback token from a lost signal', function () {
    // The token in a playback URL is short-lived, and once it has gone the
    // same address can never work again — so the answer is a fresh URL, not a
    // thirtieth attempt at a dead one.
    expect(
      addressIsWrong(
        failure({
          error: {
            errorString:
              'InvalidResponseCodeException: Response code: 403',
            errorCode: '23001'
          }
        })
      )
    ).equals(true)
  })

  it('reads AVFoundation saying the same thing', function () {
    expect(
      addressIsWrong(
        failure({ error: { localizedDescription: 'BadServerResponse (404)' } })
      )
    ).equals(true)
  })

  it('treats a field that lost its signal as worth waiting out', function () {
    expect(
      addressIsWrong(
        failure({
          error: { errorString: 'HttpDataSourceException: timeout' }
        })
      )
    ).equals(false)
  })

  it('waits out a server having a bad minute', function () {
    // 5xx is the server, not the address. A fresh URL would be answered the
    // same way, so the ladder is the right response.
    expect(
      addressIsWrong(failure({ error: { errorString: 'Response code: 503' } }))
    ).equals(false)
  })

  it('treats anything it cannot read as the network', function () {
    // The safer way round to be wrong: it costs patience rather than a stream.
    expect(addressIsWrong(failure({}))).equals(false)
    expect(addressIsWrong(failure(null))).equals(false)
  })
})
