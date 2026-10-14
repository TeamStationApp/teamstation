import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/** Guard the audited identity boundaries without banning person initials. */
describe('team identity composition boundaries', () => {
  for (const [file, mode] of [
    ['components/GameHeroCard.tsx', '<TeamEmblem'],
    ['screens/TeamScreen.tsx', '<TeamEmblem'],
    ['screens/SeasonStandings.tsx', '<TeamEmblem'],
    ['screens/DiscoverScreen.tsx', "group.kind === 'team'"],
    ['screens/TeamSelectorScene.tsx', 'teamName={row.name}'],
    ['screens/GameFormScreen.tsx', 'teamName={choice.group.name}'],
    ['screens/HomeScreen.tsx', 'teamName={team.name}'],
    ['screens/PlayerTeamsTab.tsx', 'teamName={team.teamName}'],
    ['screens/GroupSettingsScreen.tsx', "team={kind === 'team'}"],
    ['screens/CreateGroupScreen.tsx', "team={kind === 'team'}"],
    ['screens/PlaceholderTeamForm.tsx', 'team={true}'],
    ['screens/LeaguePage.tsx', 'kind="team"'],
    ['screens/SeasonPresentation.tsx', 'kind="team"']
  ])
    it(`${file} uses its explicit team identity boundary`, () => {
      expect(readFileSync(`src/app/${file}`, 'utf8')).includes(mode)
    })
})
