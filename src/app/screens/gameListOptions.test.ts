import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameListOptions } from './gameListOptions'

describe('schedule and published recording destinations', () => {
  it('allows pending schedules to open only the server-authorized request', () => {
    expect(
      gameListOptions(
        { pendingApproval: true, pendingRequestId: 'req_visible' },
        'schedule'
      )
    ).deep.equals({ pendingRequestId: 'req_visible' })
    expect(
      gameListOptions(
        { pendingApproval: true, pendingRequestId: null, videoCount: 1 },
        'schedule'
      )
    ).equals(undefined)
  })
  it('keeps published Videos controls separate from pending request navigation', () => {
    expect(
      gameListOptions(
        {
          pendingApproval: true,
          pendingRequestId: 'req_visible',
          videoCount: 1
        },
        'videos'
      )
    ).deep.equals({ tab: 'watch', autoPlay: true })
    expect(
      gameListOptions(
        { pendingApproval: true, pendingRequestId: null, videoCount: 0 },
        'videos'
      )
    ).equals(undefined)
  })
  it('preserves ordinary game opening without forwarding an obsolete request ID', () => {
    expect(
      gameListOptions(
        { pendingApproval: false, pendingRequestId: 'req_old', videoCount: 0 },
        'schedule'
      )
    ).deep.equals({ autoPlay: false })
    expect(gameListOptions({ videoCount: 2 }, 'schedule')).deep.equals({
      autoPlay: false
    })
  })
})
