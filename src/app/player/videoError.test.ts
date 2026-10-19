import { expect } from 'chai'

import { addressIsWrong } from './videoError'

/** The shape `react-native-video` hands up, with only what is read here. */
const failure = (detail: unknown): never => detail as never

describe('addressIsWrong', function () {
  it('reads ExoPlayer’s 403, which only its stack names', function () {
    // The shape react-native-video sends from media3 for a refused segment.
    expect(
      addressIsWrong(
        failure({
          error: {
            errorString: 'ExoPlaybackException: ERROR_CODE_IO_BAD_HTTP_STATUS',
            errorException:
              'androidx.media3.exoplayer.ExoPlaybackException: Source error',
            errorStackTrace: [
              'androidx.media3.exoplayer.ExoPlaybackException: Source error',
              '\tat androidx.media3.exoplayer.ExoPlayerImplInternal.handleIoException(ExoPlayerImplInternal.java:736)',
              'Caused by: androidx.media3.datasource.HttpDataSource$InvalidResponseCodeException: Response code: 403',
              '\tat androidx.media3.datasource.DefaultHttpDataSource.open(DefaultHttpDataSource.java:412)'
            ].join('\n'),
            errorCode: '22004'
          }
        })
      )
    ).equals(true)
  })

  it('reads AVFoundation’s 403 for a stream', function () {
    for (const error of [
      {
        code: -12660,
        domain: 'CoreMediaErrorDomain',
        localizedDescription: 'The operation couldn’t be completed.'
      },
      {
        code: -11800,
        domain: 'AVFoundationErrorDomain',
        localizedDescription: 'The operation could not be completed',
        localizedFailureReason: 'An unknown error occurred (-12660)'
      }
    ])
      expect(addressIsWrong(failure({ error }))).equals(true)
  })

  it('leaves a missing file to the ladder: a live playlist can be away while its writer restarts', function () {
    expect(
      addressIsWrong(
        failure({
          error: {
            errorString: 'ExoPlaybackException: ERROR_CODE_IO_BAD_HTTP_STATUS',
            errorStackTrace:
              'Caused by: androidx.media3.datasource.HttpDataSource$InvalidResponseCodeException: Response code: 404'
          }
        })
      )
    ).equals(false)
  })

  it('knows an expired playback token from a lost signal', function () {
    // The token in a playback URL is short-lived, and once it has gone the
    // same address can never work again — so the answer is a fresh URL, not a
    // thirtieth attempt at a dead one.
    expect(
      addressIsWrong(
        failure({
          error: {
            errorString: 'InvalidResponseCodeException: Response code: 403',
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

  it('reads the message, not the line numbers of the stack beside it', function () {
    // A lost signal on Android, reported with its stack: line 412 of a
    // Java file is not a 412.
    expect(
      addressIsWrong(
        failure({
          error: {
            errorString: 'ExoPlaybackException: Source error',
            errorException: 'HttpDataSourceException: Unable to connect',
            errorStackTrace:
              'at androidx.media3.datasource.DefaultHttpDataSource.open(DefaultHttpDataSource.java:412)',
            errorCode: '22001',
            cause: { stackElements: [{ lineNumber: 412 }] }
          }
        })
      )
    ).equals(false)
    // A bare message string still counts.
    expect(addressIsWrong(failure({ error: 'HTTP 403 Forbidden' }))).equals(
      true
    )
  })

  it('treats anything it cannot read as the network', function () {
    // The safer way round to be wrong: it costs patience rather than a stream.
    expect(addressIsWrong(failure({}))).equals(false)
    expect(addressIsWrong(failure(null))).equals(false)
  })
})
