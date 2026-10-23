import { expect } from 'chai'

import type { AnalyticsSink } from './apiEvents'
import { observeUpload } from './upload'

describe('Upload analytics boundary', () => {
  it('keeps successful, retried and failed uploads unchanged and never captures messages', async () => {
    const rows: unknown[] = []
    const capture = (): AnalyticsSink => (event, properties) => {
      rows.push({ event, properties })
    }
    expect(
      await observeUpload(async () => 'vid_example', capture, true)
    ).equals('vid_example')
    expect(await observeUpload(async () => 'private-canary', capture)).equals(
      'private-canary'
    )
    const failure = new Error('private-canary')
    try {
      await observeUpload(async () => {
        throw failure
      }, capture)
      expect.fail()
    } catch (caught) {
      expect(caught).equals(failure)
    }
    expect(JSON.stringify(rows)).not.includes('canary')
    expect(rows[0]).deep.equals({ event: 'upload_retry', properties: {} })
    expect(rows[2]).deep.equals({
      event: 'upload_completed',
      properties: { vi: 'vid_example' }
    })
    expect(
      await observeUpload(
        async () => 'vid_example',
        () => () => {
          throw failure
        }
      )
    ).equals('vid_example')
    expect(
      await observeUpload(
        async () => 'vid_example',
        () => {
          throw failure
        }
      )
    ).equals('vid_example')
    expect(await observeUpload(async () => 'vid_example')).equals('vid_example')
  })
})
