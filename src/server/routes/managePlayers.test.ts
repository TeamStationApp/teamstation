import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { it } from 'mocha'

import { asManagePage } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { groupFixture } from '../../test/groupFixtures'

it('marks roster players independently of email and removes only the chosen team grant', async function () {
  this.timeout(60000)
  const f = await groupFixture()
  const lines = [
    '$ mocha -r sucrase/register src/server/routes/managePlayers.test.ts'
  ]
  try {
    await f.h.db
      .insertInto('memberships')
      .values(
        [103, 104, 106].map(userId => ({
          id: `mem_manage_players_${userId}`,
          user_id: userIdOfGumbo(userId),
          team_id: f.teamA,
          is_player: userId !== 106
        }))
      )
      .execute()
    await f.h.db
      .deleteFrom('user_emails')
      .where('user_id', '=', userIdOfGumbo(103))
      .execute()
    const response = await f.h.request(
      'GET',
      `/manage/team/${f.teamA}`,
      undefined,
      101
    )
    expect(response.status).equals(200)
    const page = asManagePage(await response.json())
    lines.push(
      '$ GET /api/v1/manage/team/<fixture>',
      '200 ' + JSON.stringify(page)
    )
    for (const userId of [103, 104, 106]) {
      const person = page.people.find(
        row => row.userId === userIdOfGumbo(userId)
      )!
      expect(person.teams.find(row => row.id === f.teamA)!.isPlayer).equals(
        userIdOfGumbo(userId) !== userIdOfGumbo(106)
      )
      expect(person.emails.length > 0).equals(
        userIdOfGumbo(userId) !== userIdOfGumbo(103)
      )
    }
    const removal = await f.h.request(
      'DELETE',
      `/manage/team/${f.teamA}/people/${userIdOfGumbo(103)}`,
      undefined,
      101
    )
    const body = await removal.json()
    lines.push(
      '$ DELETE /api/v1/manage/team/<fixture>/people/usr_111111111111111111112n',
      `${removal.status} ${JSON.stringify(body)}`
    )
    expect(removal.status).equals(200)
    expect(body).deep.equals({ removed: true })
    expect(
      await f.h.db
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', userIdOfGumbo(103))
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(0)
    const dir = process.env.TS_CREATION_ARTIFACTS
    if (dir != null) {
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'manage-players-api.log'),
        lines.join('\n') + '\nPASS\n'
      )
    }
  } finally {
    await f.h.close()
  }
})
