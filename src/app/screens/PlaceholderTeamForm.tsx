import React, { useState } from 'react'
import { Modal, Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { CreateGroup, GroupPicture } from '../../common/groupCreation'
import type { Locality } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { Button, Card, TextField } from '../components'
import { GroupPictureChooser } from '../components/GroupPictureChooser'
import { LocationRow } from '../components/LocationRow'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { LocationScreen } from './LocationScreen'

/** A team on one side of a game, and a placeholder still to be made. */
export interface TeamChoice {
  group: PublicGroup
  canManage: boolean
  /** Created when the game is saved; until then `group.id` is a draft id. */
  placeholder?: CreateGroup
}

/** What the custodian of a new placeholder is chosen around. */
export interface CustodianPreference {
  sourceTeamId?: string
  participantIds: string[]
  seasonIds: string[]
}

/**
 * The groups that may keep a new placeholder, best first: the team the game
 * was started from, a team in the game, the game's season, then any other
 * group the person administers. Placeholders never keep placeholders.
 */
export function orderCustodians(
  administered: PublicGroup[],
  prefer: CustodianPreference
): PublicGroup[] {
  const kept = administered.filter(group => !group.external)
  const rank = (group: PublicGroup): number =>
    group.kind === 'team' && group.id === prefer.sourceTeamId
      ? 0
      : group.kind === 'team' && prefer.participantIds.includes(group.id)
        ? 1
        : group.kind === 'season' && prefer.seasonIds.includes(group.id)
          ? 2
          : 3
  return kept
    .map((group, index) => ({ group, index }))
    .sort((a, b) =>
      rank(a.group) !== rank(b.group)
        ? rank(a.group) - rank(b.group)
        : a.index - b.index
    )
    .map(({ group }) => group)
}

let draftCount = 0
const draftKey = (): string =>
  `placeholder-${Date.now()}-${++draftCount}-${Math.random().toString(36).slice(2)}`

type Step = 'name' | 'location' | 'logo'

/**
 * Create Placeholder Team, in Create Team's steps: a name, then an optional
 * location and logo. Nothing is written here; the game creates it on Save.
 */
export function PlaceholderTeamForm({
  client,
  custodian,
  onUse,
  onCancel
}: {
  client: TeamStationClient
  custodian: PublicGroup
  onUse: (choice: TeamChoice) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [locality, setLocality] = useState<Locality | undefined>(
    custodian.locality ?? undefined
  )
  const [locationOpen, setLocationOpen] = useState(false)
  const [picture, setPicture] = useState<GroupPicture>()
  const trimmed = name.trim()
  const named = trimmed.length > 0 && trimmed.length <= 120
  const use = (chosen: GroupPicture | undefined): void => {
    const idempotencyKey = draftKey()
    onUse({
      canManage: true,
      placeholder: {
        kind: 'team',
        name: trimmed,
        external: true,
        custodian: { kind: custodian.kind, id: custodian.id },
        ...(locality == null ? {} : { locality }),
        picture: chosen ?? { initials: true },
        idempotencyKey
      },
      group: {
        id: `draft-${idempotencyKey}`,
        kind: 'team',
        name: trimmed,
        imageUrl: null,
        locality: locality ?? null,
        startsOn: null,
        endsOn: null,
        timezone: locality?.timezone ?? 'UTC',
        external: true,
        parentNames: [],
        leagueId: null
      }
    })
  }
  const back = (): void => {
    if (step === 'name') onCancel()
    else setStep(step === 'logo' ? 'location' : 'name')
  }
  return (
    <Card style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Create Placeholder Team
      </Text>
      <Text style={styles.hint}>Kept by {custodian.name}</Text>
      {step === 'name' && (
        <TextField
          label="Team name"
          value={name}
          onChangeText={setName}
          placeholder="Hawks"
          maxLength={120}
        />
      )}
      {step === 'location' && (
        <>
          <Text style={styles.hint}>
            Optional. Choose where this team plays, or skip it.
          </Text>
          <LocationRow
            value={locality ?? null}
            onPress={() => {
              setLocationOpen(true)
            }}
          />
          {locationOpen && (
            <Modal
              visible
              animationType="slide"
              presentationStyle="fullScreen"
              onRequestClose={() => {
                setLocationOpen(false)
              }}
            >
              <LocationScreen
                client={client}
                current={locality ?? null}
                onSave={async value => {
                  setLocality(value)
                  setLocationOpen(false)
                }}
                onCancel={() => {
                  setLocationOpen(false)
                }}
              />
            </Modal>
          )}
        </>
      )}
      {step === 'logo' && (
        <GroupPictureChooser
          fitInitials
          team
          client={client}
          name={trimmed}
          value={picture}
          onChange={setPicture}
        />
      )}
      {step === 'name' && (
        <Button
          label="Continue"
          disabled={!named}
          onPress={() => {
            setStep('location')
          }}
        />
      )}
      {step === 'location' && (
        <>
          <Button
            label="Continue"
            disabled={locality == null}
            onPress={() => {
              setStep('logo')
            }}
          />
          <Button
            label="Skip"
            kind="text"
            onPress={() => {
              setLocality(undefined)
              setStep('logo')
            }}
          />
        </>
      )}
      {step === 'logo' && (
        <>
          <Button
            label="Use Placeholder Team"
            onPress={() => {
              use(picture)
            }}
          />
          <Button
            label="Skip"
            kind="text"
            onPress={() => {
              use(undefined)
            }}
          />
        </>
      )}
      {step === 'name' ? (
        <Button
          label="Cancel"
          kind="text"
          textColor={theme.dangerColor}
          onPress={back}
        />
      ) : (
        <Button label="Previous step" kind="secondary" onPress={back} />
      )}
    </Card>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  }
}))
