import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * Guard the audited identity tiles, as `teamEmblemUsage.test.ts` guards the
 * group ones: every person drawn as initials is drawn by `PersonEmblem`
 * (directly, or through `ListRow`'s `person`), on the colour their account
 * id gives them, and every team, league and season by `TeamEmblem` or
 * `GroupEmblem`. No other file draws initials of its own, and no tile's
 * colour is taken from a name: every tint hashes an id.
 */

const ROOT = 'src/app'

/** Where initials may be drawn: the tiles themselves. */
const TILES = new Set([
  'components/PersonEmblem.tsx',
  'components/GroupEmblem.tsx',
  'components/TeamEmblem.tsx',
  'components/teamTile.ts'
])

/**
 * Tiles that are neither people nor groups, each named: a linked chat device
 * (its own name's initials), and a layout fixture's sample row.
 */
const DEVICE_TILES = new Set([
  'chat/ChatDevicesScreen.tsx',
  'components/cardSpacingFixture.tsx'
])

/** Files that draw `<Emblem` itself: the tiles, and the ones drawing an icon. */
const EMBLEM_DRAWERS = new Set([
  ...TILES,
  // Draws the tiles `chatIdentityModel` builds: `PersonEmblem`'s colour for
  // a person, `GroupEmblem`'s for a scope.
  'chat/ChatAvatar.tsx',
  // `emblem` and `emblemIcon` rows that are not people or groups.
  'components/ListRow.tsx'
])

/** Files whose `<Emblem` is a Material Symbol with no letters. */
const ICON_TILES = new Set([
  'stream/CameraRow.tsx',
  'screens/VenueScreen.tsx',
  'screens/InvitationsWaiting.tsx',
  'walkup/WalkUpSongScreen.tsx',
  'walkup/WalkUpTab.tsx'
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(entry.name)) return []
    if (/\.(test|e2e)\.tsx?$/.test(entry.name)) return []
    if (/\.test\.helpers\.tsx?$/.test(entry.name)) return []
    return [path]
  })
}

/** Each `<Emblem …>` element's attributes, up to its close. */
function emblems(source: string): string[] {
  return [...source.matchAll(/<Emblem\b([\s\S]*?)\/?>/g)].map(m => m[1])
}

/**
 * Why a file under `src/app` draws a tile of its own, or nothing when it
 * does not: initials beside an `<Emblem` or a `ListRow` `emblem=`, an
 * `<Emblem` with letters outside the tiles, or a lettered `emblem=`.
 */
export function tileOffences(file: string, source: string): string[] {
  if (TILES.has(file)) return []
  const found: string[] = []
  const initials = /\b(person)?[iI]nitialsOf\(/.test(source)
  const draws = /<Emblem\b/.test(source)
  const lettered = /\bemblem=\{/.test(source) || /\bemblem="/.test(source)
  if (initials && (draws || lettered) && !DEVICE_TILES.has(file))
    found.push('draws initials outside PersonEmblem, GroupEmblem or TeamEmblem')
  if (draws && !EMBLEM_DRAWERS.has(file)) {
    if (!ICON_TILES.has(file)) found.push('draws an Emblem of its own')
    for (const attributes of emblems(source))
      if (!/\bfallback=""/.test(attributes) || !/\bicon=/.test(attributes))
        found.push('draws letters on an Emblem')
  }
  if (lettered && !DEVICE_TILES.has(file))
    found.push('draws letters in a ListRow emblem')
  return found
}

/** The tint functions, each hashing one id. */
const TINTS = /\b(teamTint|leagueTint|seasonTint|groupTint|personTint)\(/g

/** What a tint's argument may not be: a name, a title or a label. */
const NAMED = /\b\w*(?:[nN]ame|[tT]itle|[lL]abel)\b|\bname\b/

/**
 * Every tint call in `source` whose argument names a name, a title, a label
 * or a display name, or is any string but the former member's constant key.
 * The tints' own definitions are not calls.
 */
export function tintOffences(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(TINTS)) {
    const before = source.slice(Math.max(0, match.index - 9), match.index)
    if (/function\s$/.test(before)) continue
    let depth = 0
    let end = match.index + match[0].length - 1
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++
      else if (source[end] === ')' && --depth === 0) break
    }
    const argument = source.slice(match.index + match[0].length, end)
    const strings = [...argument.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    if (
      NAMED.test(argument) ||
      strings.some(string => string[0] !== "'former-member'")
    )
      found.push(`${match[1]}(${argument})`)
  }
  return found
}

describe('identity tile colours', () => {
  it('colours every tile under src/app by its id alone', () => {
    const offences = sources(ROOT).flatMap(path =>
      tintOffences(readFileSync(path, 'utf8')).map(
        call => `${relative(ROOT, path)}: ${call}`
      )
    )
    expect(offences).deep.equals([])
  })

  it('fails a tint taken from a name, a title, a label or another string', () => {
    for (const call of [
      'teamTint(team.name)',
      'leagueTint(league.displayName)',
      'seasonTint({ id: season.title })',
      'groupTint({ ...group, id: label })',
      'personTint(person.shortName)',
      'personTint(userId + publicName)',
      "teamTint('Demo Hawks')"
    ])
      expect(tintOffences(call)).deep.equals([call])
  })

  it('passes a tint of an id, and of the former member’s key', () => {
    for (const call of [
      'teamTint(team.id)',
      'leagueTint(group.leagueId)',
      'seasonTint({ id: group.id, leagueId: group.leagueId })',
      'groupTint({ ...group, id })',
      'personTint(person.userId)',
      "teamTint('former-member')",
      'export function personTint(userId: string) {}'
    ])
      expect(tintOffences(call)).deep.equals([])
  })
})

describe('identity tile composition boundaries', () => {
  it('draws every person, team, league and season tile through its tile', () => {
    const offences = sources(ROOT).flatMap(path => {
      const file = relative(ROOT, path)
      return tileOffences(file, readFileSync(path, 'utf8')).map(
        reason => `${file}: ${reason}`
      )
    })
    expect(offences).deep.equals([])
  })

  it('fails a file that draws person initials outside PersonEmblem', () => {
    expect(
      tileOffences(
        'screens/RosterScreen.tsx',
        `<Emblem uri={row.avatarUrl} fallback={initialsOf(row.name)} />`
      )
    ).includes('draws initials outside PersonEmblem, GroupEmblem or TeamEmblem')
    expect(
      tileOffences(
        'screens/RosterScreen.tsx',
        `<ListRow title={name} emblem={initialsOf(name)} />`
      )
    ).includes('draws letters in a ListRow emblem')
    expect(
      tileOffences(
        'screens/RosterScreen.tsx',
        `<Emblem fallback={p.name.slice(0, 1)} shape="circle" />`
      )
    ).includes('draws letters on an Emblem')
    expect(
      tileOffences(
        'stream/CameraRow.tsx',
        `<Emblem fallback={initialsOf(stream.ownerName)} />`
      )
    ).not.deep.equals([])
  })

  it('leaves the tiles, the named devices and the icon tiles alone', () => {
    expect(
      tileOffences(
        'components/PersonEmblem.tsx',
        `<Emblem fallback={tile.initials} />`
      )
    ).deep.equals([])
    expect(
      tileOffences(
        'chat/ChatDevicesScreen.tsx',
        `<ListRow title={device.name} emblem={initialsOf(device.name)} />`
      )
    ).deep.equals([])
    expect(
      tileOffences(
        'screens/VenueScreen.tsx',
        `<ListRow leading={<Emblem fallback="" icon="add" />} />`
      )
    ).deep.equals([])
  })

  for (const [file, mode] of [
    [
      'components/PersonSearchRow.tsx',
      '<PersonEmblem\n        userId={userId}'
    ],
    ['components/PeopleList.tsx', 'person={{\n        userId: person.userId,'],
    ['screens/PublicTeamContent.tsx', 'userId: person.userId,'],
    ['components/CandidateCard.tsx', 'userId={candidate.userId}'],
    ['scoring/ScoringCandidateCard.tsx', 'userId={candidate.userId}'],
    ['screens/AccountScreen.tsx', 'person={{ userId: user.id }}'],
    ['screens/ManagePlayers.tsx', 'userId={person.userId}'],
    ['screens/PlayerScreen.tsx', 'name={shown}'],
    ['screens/PersonProfileScreen.tsx', 'name={name}'],
    ['screens/PersonProfileScreen.tsx', 'userId: child.userId,'],
    ['screens/HomeScreen.tsx', 'userId: player.userId,'],
    ['screens/NodeAdministrationScreen.tsx', 'userId: account.userId,'],
    ['screens/EventInfoTab.tsx', 'name={row.name}'],
    ['screens/EventInfoTab.tsx', 'userId: row.userId,'],
    ['screens/EventRsvpModal.tsx', 'name={row.name}'],
    ['screens/ScheduleRsvpControl.tsx', 'name={row.name}'],
    ['umpires/GameUmpires.tsx', 'userId: person.userId,'],
    ['umpires/LeagueUmpiresScreen.tsx', 'name={p.name}'],
    ['stream/CameraRow.tsx', 'name={stream.ownerName}'],
    ['chat/NewDmScreen.tsx', 'name={person.shortName}'],
    ['components/AppHeader.tsx', '<PersonEmblem'],
    ['components/GroupPictureChooser.tsx', '{...person}'],
    [
      'chat/chatIdentityModel.ts',
      'personTile({ userId, name: member.shortName })'
    ],
    ['chat/chatIdentityModel.ts', "tint: teamTint('former-member'),"]
  ])
    it(`${file} draws its person through PersonEmblem's boundary`, () => {
      expect(readFileSync(`${ROOT}/${file}`, 'utf8')).includes(mode)
    })
})
