import { expect } from 'chai'
import { describe, it } from 'mocha'

import { EDITS_PLACE as WEB } from './editsPlace'
import { EDITS_PLACE as PHONE } from './editsPlace.native'

describe('where unsent edits are kept, as the screens say it', function () {
  it('keeps the phone’s words, and names the tab on the web', function () {
    // The phone's sentences read as they did before the web shared them.
    expect(`Using the server's copy deletes ${PHONE.scored}.`).equals(
      "Using the server's copy deletes what this phone scored for this game and has not sent."
    )
    expect(
      `Using the server's copy takes ${PHONE.playersAdded} off the team and shows its roster as the server has it.`
    ).equals(
      "Using the server's copy takes the players this phone added off the team and shows its roster as the server has it."
    )
    expect(
      `${PHONE.changes} to the game are gone. Try again once ${PHONE.backOnline}.`
    ).equals(
      "This phone's changes to the game are gone. Try again once the phone is back online."
    )
    expect(PHONE.on).equals('on this phone')
    expect(
      `A player this names was not saved, and was taken ${PHONE.takenOff}.`
    ).equals('A player this names was not saved, and was taken off this phone.')
    expect(
      `This game is not ${PHONE.stored} yet. Try again in a moment.`
    ).equals('This game is not on the phone yet. Try again in a moment.')
    // The web's keep the same shape, about this tab.
    for (const words of Object.values(WEB)) expect(words).not.includes('phone')
    expect(WEB.on).equals('in this tab')
    expect(Object.keys(WEB)).deep.equals(Object.keys(PHONE))
  })
})
