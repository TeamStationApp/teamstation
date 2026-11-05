import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, it } from 'mocha'

import {
  CAMERAMAN_APP,
  DIRECTOR_APP,
  FIELD_TEAM,
  fieldOrigin,
  writeFieldClientConfig
} from '../../Masonfile'

describe('field app builds', function () {
  let dir = ''
  afterEach(function () {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('keeps a master build on the production host and every other branch on develop', function () {
    assert.equal(fieldOrigin('master'), 'https://app.teamstation.app')
    assert.equal(fieldOrigin(undefined), 'https://app.teamstation.app')
    assert.equal(fieldOrigin('develop'), 'https://develop.teamstation.app')
    assert.equal(fieldOrigin('paul/example'), 'https://develop.teamstation.app')
  })

  it('writes the team and the link host the native projects read', function () {
    dir = mkdtempSync(path.join(tmpdir(), 'field-app-'))
    writeFieldClientConfig(dir, 'develop')
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'clientConfig.json'), 'utf8')), {
      appleTeamId: FIELD_TEAM,
      appOrigin: 'https://develop.teamstation.app'
    })
    assert.equal(DIRECTOR_APP, 'app.teamstation.director')
    assert.equal(CAMERAMAN_APP, 'app.teamstation.cameraman')
  })
})
