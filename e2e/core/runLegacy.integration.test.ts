import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { stopGroup } from './runLegacy'

describe('runLegacy stopping', function () {
  it('stops the whole group a script started, and waits for it', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'runLegacyGroup-'))
    const pidFile = join(dir, 'grandchild')
    try {
      // Stands in for npx: it starts the real runner and ignores SIGTERM.
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('child_process')
          const fs = require('fs')
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          process.on('SIGTERM', () => {})
          setInterval(() => {}, 1000)`
        ],
        { detached: true, stdio: 'ignore' }
      )
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const grandchild = Number(readFileSync(pidFile, 'utf8'))
      await stopGroup(parent, 300)
      expect(parent.signalCode).equals('SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(() => process.kill(grandchild, 0)).to.throw()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
