import { expect } from 'chai'
import { describe, it } from 'mocha'

import { recoveryFixtureEnvironment } from '../../src/test/chatRecoveryFixtureContract'
import { readFixtureEnvironment } from './chatFixture'
import { stackDatabase } from './legacyStack'

describe('chat recovery fixtures in the sweep', function () {
  it("reads back the producer's env.sh, quotes and all", function () {
    const values = {
      CHAT_UI_MESSAGE: 'msg_1',
      CHAT_UI_TARGET_TEXT: "It's a 'quoted' line",
      CHAT_UI_PROFILE_DIR: '/tmp/a b/holder'
    }
    expect(
      readFixtureEnvironment(recoveryFixtureEnvironment(values))
    ).deep.equals(values)
  })

  it('names the stack database as given, or its own', function () {
    expect(stackDatabase(undefined)).equals('teamstation_e2eStack')
    expect(stackDatabase('')).equals('teamstation_e2eStack')
    expect(stackDatabase('TeamStation_e2eSuite')).equals('TeamStation_e2eSuite')
    expect(() => stackDatabase('x; drop')).throws(/not a plain database name/)
  })
})
