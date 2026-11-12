import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * Guard the audited group identity boundaries: every team, league and season
 * tile is drawn by `TeamEmblem` or `GroupEmblem` (directly, or through
 * `ListRow`'s `group`), from the group's id, and no row picks a colour of its
 * own.
 */
describe('group identity composition boundaries', () => {
  for (const [file, mode] of [
    ['components/GameHeroCard.tsx', '<TeamEmblem teamId={props.teamId}'],
    ['screens/TeamScreen.tsx', '<TeamEmblem\n            teamId={team.id}'],
    ['screens/SeasonStandings.tsx', 'teamId={row.teamId}'],
    ['screens/DiscoverScreen.tsx', '<GroupSearchCard'],
    [
      'components/GroupSearchCard.tsx',
      'group={{\n            kind: group.kind,'
    ],
    [
      'screens/TeamSelectorScene.tsx',
      "kind: 'team',\n                        id: row.id,"
    ],
    [
      'screens/GameFormScreen.tsx',
      "kind: 'team',\n          id: choice.group.id,"
    ],
    [
      'screens/HomeScreen.tsx',
      "kind: 'team',\n                    id: team.id,"
    ],
    [
      'screens/HomeScreen.tsx',
      "kind: 'season',\n                    id: season.id,"
    ],
    [
      'screens/HomeScreen.tsx',
      "kind: 'league',\n                    id: row.id,"
    ],
    ['screens/HomeScreen.tsx', 'id: game.homeTeamId,'],
    ['screens/HomeScreen.tsx', 'leagueUri: group.leaguePictureUrl'],
    ['screens/PlayerTeamsTab.tsx', 'id: team.teamId,'],
    [
      'screens/FollowTeamScreen.tsx',
      "kind: 'team',\n                        id: team.id,"
    ],
    [
      'screens/GroupSettingsScreen.tsx',
      'leagueUri: detail.group.leaguePictureUrl'
    ],
    ['screens/CreateGroupScreen.tsx', 'group={{ kind, id: null }}'],
    ['screens/PlaceholderTeamForm.tsx', "group={{ kind: 'team', id: null }}"],
    ['screens/LeaguePage.tsx', '<GroupRelationshipRow'],
    ['screens/LeaguePage.tsx', '<GroupEmblem\n          kind="league"'],
    ['screens/SeasonPresentation.tsx', '<GroupRelationshipRow'],
    ['screens/SeasonPresentation.tsx', 'leagueUri={leagueMark}'],
    ['screens/ParentChooser.tsx', 'leagueUri={season.leaguePictureUrl}'],
    [
      'screens/GroupRelationshipRow.tsx',
      '<GroupEmblem\n          kind={group.kind}'
    ],
    [
      'umpires/UmpireRequirementsScreen.tsx',
      'leagueUri: season.leaguePictureUrl'
    ],
    [
      'umpires/UmpireScheduleScreen.tsx',
      '<GroupEmblem\n                    kind="league"'
    ],
    ['chat/chatIdentityModel.ts', 'tint: groupTint(group),']
  ])
    it(`${file} uses its explicit group identity boundary`, () => {
      expect(readFileSync(`src/app/${file}`, 'utf8')).includes(mode)
    })

  it('names no team by its name for a colour', () => {
    for (const file of [
      'components/TeamEmblem.tsx',
      'components/GroupEmblem.tsx',
      'components/ListRow.tsx',
      'chat/chatIdentityModel.ts'
    ])
      expect(readFileSync(`src/app/${file}`, 'utf8')).not.match(
        /teamTint\((name|normalized|props\.name)/
      )
    expect(readFileSync('src/app/components/ListRow.tsx', 'utf8')).not.includes(
      'teamName'
    )
  })
})
