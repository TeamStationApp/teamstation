import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { describe, it } from 'mocha'

import { androidSmokeRecording, watchSmokeRecorder } from './smokeRecorder'

describe('native smoke recording cleanup without a simulator', () => {
  it('stops Android capture and removes its own file after startup or UI failure, without duplicate stops', async () => {
    for (const failure of ['startup', 'gesture', 'none']) {
      const calls: string[] = []
      const recording = androidSmokeRecording(
        {
          start: async () => {
            calls.push('start')
            if (failure === 'startup') throw new Error('lost acknowledgement')
          },
          stop: async () => {
            calls.push('stop')
          }
        },
        () => {
          calls.push('remove')
        }
      )
      try {
        await recording.start()
        if (failure === 'gesture') throw new Error('gesture failed')
        await recording.stop()
      } catch (error) {
        assert.match(String(error), /acknowledgement|gesture/)
      } finally {
        await recording.dispose()
      }
      await recording.dispose()
      assert.deepEqual(calls, ['start', 'stop', 'remove'])
    }
  })
  it('settles even when the recorder exited before stop was called', async () => {
    for (const code of [0, 2]) {
      const monitor = watchSmokeRecorder(
        spawn(process.execPath, ['-e', `process.exit(${code})`])
      )
      await assert.rejects(monitor.completion, /unexpectedly/)
      await assert.rejects(monitor.stop(), /unexpectedly/)
    }
  })
  it('reports startup errors and allows an intentional recording stop', async () => {
    const missing = watchSmokeRecorder(spawn('/missing/smoke-recorder'))
    await assert.rejects(missing.completion, /ENOENT/)
    await assert.rejects(missing.stop(), /ENOENT/)
    const monitor = watchSmokeRecorder(
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    )
    await monitor.stop()
    await monitor.completion
  })
})
