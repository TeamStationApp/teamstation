import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type BackgroundJobs,
  skipWhileRunning,
  startBackgroundJobs,
  type Stoppable
} from './backgroundJobs'

const OFF: Stoppable = { stop: async () => undefined }

/** A child that writes down the signal it was stopped with. */
function child(name: string, ran: string[]): Stoppable {
  return {
    stop: async signal => {
      ran.push(`stop ${name} ${String(signal)}`)
    }
  }
}

/** Jobs that write down that they ran, with the path's own key sweep. */
function recordingJobs(
  ran: string[],
  keySweep: boolean
): BackgroundJobs<Stoppable> {
  const job = (name: string) => (): void => {
    ran.push(name)
  }
  return {
    reopenInterrupted: job('reopenInterrupted'),
    startPurge: job('startPurge'),
    startDiscardSweep: job('startDiscardSweep'),
    ...(keySweep ? { startKeySweep: job('startKeySweep') } : {}),
    startLocalCopyWarnings: job('startLocalCopyWarnings'),
    startRsvpReminders: job('startRsvpReminders'),
    startChatAttachmentPurge: job('startChatAttachmentPurge'),
    startChatReconciler: job('startChatReconciler'),
    startRosterBumpPrune: job('startRosterBumpPrune'),
    startPushSender: () => {
      ran.push('startPushSender')
      return child('pushSender', ran)
    },
    startStatsBuilder: () => {
      ran.push('startStatsBuilder')
      return child('statsBuilder', ran)
    }
  }
}

describe('startBackgroundJobs', function () {
  it('runs each job of the forking path, and stops both children at once', async function () {
    const ran: string[] = []
    const said: string[] = []
    const children = startBackgroundJobs(
      true,
      recordingJobs(ran, true),
      OFF,
      message => said.push(message)
    )
    expect(children).not.equals(OFF)
    expect(ran).deep.equals([
      'reopenInterrupted',
      'startPurge',
      'startDiscardSweep',
      'startKeySweep',
      'startLocalCopyWarnings',
      'startRsvpReminders',
      'startChatAttachmentPurge',
      'startChatReconciler',
      'startRosterBumpPrune',
      'startPushSender',
      'startStatsBuilder'
    ])
    expect(said).deep.equals([])
    ran.length = 0
    await children.stop('SIGTERM')
    expect(ran).deep.equals([
      'stop pushSender SIGTERM',
      'stop statsBuilder SIGTERM'
    ])
  })

  it('adds no key sweep to the unclustered path', function () {
    const ran: string[] = []
    startBackgroundJobs(true, recordingJobs(ran, false), OFF, () => undefined)
    expect(ran).deep.equals([
      'reopenInterrupted',
      'startPurge',
      'startDiscardSweep',
      'startLocalCopyWarnings',
      'startRsvpReminders',
      'startChatAttachmentPurge',
      'startChatReconciler',
      'startRosterBumpPrune',
      'startPushSender',
      'startStatsBuilder'
    ])
  })

  it('starts the RSVP reminder sweep when on, and not when off', function () {
    for (const enabled of [true, false]) {
      const ran: string[] = []
      startBackgroundJobs(
        enabled,
        recordingJobs(ran, false),
        OFF,
        () => undefined
      )
      expect(ran.includes('startRsvpReminders')).equals(enabled)
    }
  })

  it('supervises the push sender only when on', function () {
    for (const enabled of [true, false]) {
      const ran: string[] = []
      startBackgroundJobs(
        enabled,
        recordingJobs(ran, false),
        OFF,
        () => undefined
      )
      expect(ran.includes('startPushSender')).equals(enabled)
    }
  })

  for (const keySweep of [true, false]) {
    it(`runs none of them when off, ${keySweep ? 'forking' : 'unclustered'}, and says so`, function () {
      const ran: string[] = []
      const said: string[] = []
      const children = startBackgroundJobs(
        false,
        recordingJobs(ran, keySweep),
        OFF,
        message => said.push(message)
      )
      expect(children).equals(OFF)
      expect(ran).deep.equals([])
      expect(said).deep.equals([
        'background jobs are switched off (backgroundJobs is false)'
      ])
    })
  }
})

describe('skipWhileRunning', function () {
  it('skips a start while the last sweep runs, and starts again once it ends', async function () {
    let starts = 0
    let finish = (): void => {}
    const sweep = skipWhileRunning(async () => {
      await new Promise<void>(resolve => {
        starts++
        finish = resolve
      })
    })
    sweep()
    sweep()
    expect(starts).equals(1)
    finish()
    await new Promise(resolve => setImmediate(resolve))
    sweep()
    expect(starts).equals(2)
    finish()
  })

  it('starts again after a sweep that failed', async function () {
    let starts = 0
    const sweep = skipWhileRunning(async () => {
      starts++
      throw new Error('stalled')
    })
    sweep()
    await new Promise(resolve => setImmediate(resolve))
    sweep()
    expect(starts).equals(2)
  })
})
