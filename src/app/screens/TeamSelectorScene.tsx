import React, { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { localityLabel } from '../../common/locality'
import type { PublicGroup, SearchRow } from '../../common/publicGroups'
import { Button, Emblem, initialsOf, TextField } from '../components'
import { ListRow } from '../components/ListRow'
import { RadioMark } from '../components/RadioMark'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { PlaceholderTeamForm, type TeamChoice } from './PlaceholderTeamForm'

export interface TeamSelectorAnchor {
  teamId?: string
  seasonId?: string
}

/** The seasons and leagues a row names, else where it plays. */
export function teamRowContext(row: SearchRow): string {
  const names = [...new Set([...(row.seasonNames ?? []), ...row.parentNames])]
  const parts =
    names.length > 0
      ? names
      : row.locality == null
        ? []
        : [localityLabel(row.locality)]
  if (row.external) parts.push('Placeholder')
  return parts.join(' · ')
}

/**
 * Choose a team for one side of a game, in a scene of its own that slides up
 * over the game: suggestions before a search, any team after one, and a
 * placeholder last. Closing it changes nothing.
 */
export function TeamSelectorScene({
  client,
  title,
  anchor,
  excludeIds,
  currentId,
  custodians,
  custodianNote,
  onChoose,
  onClose
}: {
  client: TeamStationClient
  title: string
  anchor: TeamSelectorAnchor
  excludeIds: string[]
  /** The team this side holds now, marked where it is listed. */
  currentId?: string
  /** Who may keep a new placeholder, best first; empty when nobody may. */
  custodians: PublicGroup[]
  /** Said in place of the placeholder row's detail while it cannot be used. */
  custodianNote?: string
  onChoose: (choice: TeamChoice) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SearchRow[]>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [placing, setPlacing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  // A team that answers after the scene has closed was not chosen.
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const searching = query.trim() !== ''
  const { teamId, seasonId } = anchor
  const suggesting = teamId != null || seasonId != null
  useEffect(() => {
    let active = true
    setError('')
    setRows(undefined)
    if (!searching && !suggesting) {
      setRows([])
      return
    }
    const load = async (): Promise<SearchRow[]> =>
      searching
        ? await client.discoverGroups('team', query.trim())
        : await client.relatedTeams({
            ...(teamId == null ? {} : { teamId }),
            ...(seasonId == null ? {} : { seasonId })
          })
    const timer = setTimeout(
      () => {
        load().then(
          found => {
            if (active) setRows(found)
          },
          () => {
            if (active) setError('Teams could not load. Try searching again.')
          }
        )
      },
      searching ? 250 : 0
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, query, searching, suggesting, teamId, seasonId, retry])
  const shown = [
    ...new Map(
      (rows ?? [])
        .filter(row => row.kind === 'team' && !excludeIds.includes(row.id))
        .map(row => [row.id, row])
    ).values()
  ]
  const choose = async (row: SearchRow): Promise<void> => {
    if (choosing) return
    setChoosing(true)
    setError('')
    try {
      const detail = await client.group({ kind: 'team', id: row.id })
      if (open.current)
        onChoose({
          group: detail.group,
          canManage: detail.canManage || detail.canManagePeople === true
        })
    } catch (caught) {
      if (open.current)
        setError(
          caught instanceof Error ? caught.message : 'That team could not load.'
        )
    } finally {
      if (open.current) setChoosing(false)
    }
  }
  const custodian = custodians[0]
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.scene,
          { paddingTop: insets.top, paddingBottom: insets.bottom }
        ]}
        testID="team-selector"
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Button
            label="Cancel"
            accessibilityLabel="Cancel team selector"
            kind="text"
            textColor={theme.dangerColor}
            onPress={onClose}
          />
        </View>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {placing && custodian != null ? (
            <PlaceholderTeamForm
              client={client}
              custodian={custodian}
              onUse={onChoose}
              onCancel={() => {
                setPlacing(false)
              }}
            />
          ) : (
            <>
              <TextField
                label="Search all teams"
                value={query}
                onChangeText={setQuery}
                placeholder="Team name, city or state"
              />
              {!searching && suggesting && (
                <Text style={styles.section}>Suggested</Text>
              )}
              {error !== '' && (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {error}
                  </Text>
                  <Button
                    label="Retry"
                    kind="secondary"
                    onPress={() => {
                      setRetry(value => value + 1)
                    }}
                  />
                </>
              )}
              {rows == null && error === '' && (
                <Text style={styles.hint}>Loading teams…</Text>
              )}
              {searching && rows != null && shown.length === 0 && (
                <Text style={styles.hint}>
                  No teams match “{query.trim()}”.
                </Text>
              )}
              <View style={styles.list}>
                {shown.map((row, index) => (
                  <Pressable
                    key={row.id}
                    testID={`team-result-${row.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Choose ${row.name}`}
                    aria-selected={row.id === currentId}
                    disabled={choosing}
                    onPress={() => {
                      choose(row).catch(() => undefined)
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      index > 0 && styles.divider,
                      pressed && styles.pressed
                    ]}
                  >
                    <Emblem
                      uri={row.imageUrl}
                      fallback={initialsOf(row.name)}
                      icon={row.external ? 'groups' : undefined}
                    />
                    <View style={styles.rowText}>
                      <Text style={styles.name} numberOfLines={1}>
                        {row.name}
                      </Text>
                      {teamRowContext(row) !== '' && (
                        <Text style={styles.detail} numberOfLines={1}>
                          {teamRowContext(row)}
                        </Text>
                      )}
                      {(row.staffNames ?? []).length > 0 && (
                        <Text
                          style={styles.detail}
                          numberOfLines={1}
                          testID={`team-staff-${row.id}`}
                        >
                          {(row.staffNames ?? []).join(', ')}
                        </Text>
                      )}
                    </View>
                    <RadioMark on={row.id === currentId} />
                  </Pressable>
                ))}
                <ListRow
                  title="Create Placeholder Team"
                  subtitle={
                    custodianNote ??
                    (custodian == null
                      ? 'You need to manage a team or season to create a placeholder.'
                      : 'A team that is not on TeamStation yet')
                  }
                  subtitleNumberOfLines={2}
                  emblemIcon="groups"
                  onPress={
                    custodian == null || custodianNote != null
                      ? undefined
                      : () => {
                          setPlacing(true)
                        }
                  }
                />
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scene: { flex: 1, backgroundColor: theme.backgroundColor },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  title: {
    flex: 1,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  body: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    padding: theme.rem(1),
    gap: theme.rem(0.75)
  },
  section: {
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    textTransform: 'uppercase'
  },
  list: { gap: theme.rem(0.25) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    minHeight: theme.rem(4),
    paddingVertical: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.5),
    borderRadius: theme.rem(0.75)
  },
  pressed: { backgroundColor: theme.highlightRowActiveBackground },
  divider: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  rowText: { flex: 1, gap: theme.rem(0.125) },
  name: {
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  detail: {
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
