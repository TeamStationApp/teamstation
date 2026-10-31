import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type BackgroundJobs, startBackgroundJobs } from './backgroundJobs'

const BUILDER = 'the builder'
const OFF = 'nothing to stop'

/** Jobs that write down that they ran, with the path's own key sweep. */
function recordingJobs(
  ran: string[],
  keySweep: boolean
): BackgroundJobs<string> {
  const job = (name: string) => (): void => {
    ran.push(name)
  }
  return {
    reopenInterrupted: job('reopenInterrupted'),
    startPurge: job('startPurge'),
    ...(keySweep ? { startKeySweep: job('startKeySweep') } : {}),
    startChatAttachmentPurge: job('startChatAttachmentPurge'),
    startChatReconciler: job('startChatReconciler'),
    startStatsBuilder: () => {
      ran.push('startStatsBuilder')
      return BUILDER
    }
  }
}

describe('startBackgroundJobs', function () {
  it('runs each job of the forking path, and answers the builder', function () {
    const ran: string[] = []
    const said: string[] = []
    const builder = startBackgroundJobs(
      true,
      recordingJobs(ran, true),
      OFF,
      message => said.push(message)
    )
    expect(builder).equals(BUILDER)
    expect(ran).deep.equals([
      'reopenInterrupted',
      'startPurge',
      'startKeySweep',
      'startChatAttachmentPurge',
      'startChatReconciler',
      'startStatsBuilder'
    ])
    expect(said).deep.equals([])
  })

  it('adds no key sweep to the unclustered path', function () {
    const ran: string[] = []
    startBackgroundJobs(true, recordingJobs(ran, false), OFF, () => undefined)
    expect(ran).deep.equals([
      'reopenInterrupted',
      'startPurge',
      'startChatAttachmentPurge',
      'startChatReconciler',
      'startStatsBuilder'
    ])
  })

  for (const keySweep of [true, false]) {
    it(`runs none of them when off, ${keySweep ? 'forking' : 'unclustered'}, and says so`, function () {
      const ran: string[] = []
      const said: string[] = []
      const builder = startBackgroundJobs(
        false,
        recordingJobs(ran, keySweep),
        OFF,
        message => said.push(message)
      )
      expect(builder).equals(OFF)
      expect(ran).deep.equals([])
      expect(said).deep.equals([
        'background jobs are switched off (backgroundJobs is false)'
      ])
    })
  }
})
