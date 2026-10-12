import React, { useCallback, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GameScheduleProposal } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { Button, Card, SectionHeader } from '../components'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function GroupGameSchedule({
  client,
  groupRef,
  onRequest,
  disabled = false
}: {
  client: TeamStationClient
  groupRef: GroupRef
  onRequest: (id: string) => void
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const { kind, id } = groupRef
  const [proposals, setProposals] = useState<GameScheduleProposal[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const load = useCallback(async (): Promise<void> => {
    try {
      const found = await client.gameProposals({ kind, id })
      const teams = await Promise.all(
        [
          ...new Set(
            found.flatMap(row => [row.game.homeTeamId, row.game.awayTeamId])
          )
        ].map(
          async teamId =>
            (await client.group({ kind: 'team', id: teamId })).group
        )
      )
      setProposals(found)
      setNames(Object.fromEntries(teams.map(team => [team.id, team.name])))
      setError('')
    } catch (error) {
      setProposals([])
      setError(
        error instanceof Error
          ? error.message
          : 'Game proposals could not load. Retry.'
      )
    }
  }, [client, kind, id])
  useForegroundRefresh(load)
  const remove = async (requestId: string): Promise<void> => {
    try {
      await client.deleteDeclinedGame(requestId, { kind, id })
      await load()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The declined entry could not be removed. Retry.'
      )
    }
  }
  return (
    <View style={styles.section}>
      {proposals.length > 0 && <SectionHeader title="Game proposals" />}
      {proposals.map(proposal => (
        <Card key={proposal.requestId} style={styles.card}>
          <Text style={styles.title}>
            {names[proposal.game.awayTeamId] ?? 'Away team'} at{' '}
            {names[proposal.game.homeTeamId] ?? 'Home team'}
          </Text>
          <Text style={styles.hint}>
            {new Date(proposal.game.startAt).toLocaleString()}
            {proposal.game.venue == null ? '' : ` · ${proposal.game.venue}`}
          </Text>
          <Text style={styles.status}>
            {proposal.status === 'declined' ? 'Declined' : 'Awaiting approval'}
            {proposal.gameId == null
              ? ''
              : ' · Proposed change; current approved schedule remains'}
          </Text>
          <Button
            label="Open game proposal"
            disabled={disabled}
            kind="secondary"
            onPress={() => {
              onRequest(proposal.requestId)
            }}
          />
          {proposal.canDelete && (
            <Button
              label="Delete declined entry"
              disabled={disabled}
              kind="secondary"
              onPress={() => {
                remove(proposal.requestId).catch(() => undefined)
              }}
            />
          )}
        </Card>
      ))}
      {error !== '' && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button
            label="Retry game proposals"
            disabled={disabled}
            kind="secondary"
            onPress={() => {
              load().catch(() => undefined)
            }}
          />
        </>
      )}
    </View>
  )
}

export function GameSchedulingControls({
  client,
  gameId,
  teamNames,
  onEdit,
  onChanged
}: {
  client: TeamStationClient
  gameId: string
  teamNames: Record<string, string>
  onEdit: () => void
  onChanged: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [canPropose, setCanPropose] = useState(false)
  const [teams, setTeams] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async (): Promise<void> => {
    try {
      const state = await client.gameScheduling(gameId)
      setCanPropose(state.canPropose)
      setTeams(state.withdrawTeamIds)
    } catch {
      setCanPropose(false)
      setTeams([])
    }
  }, [client, gameId])
  useForegroundRefresh(load)
  const withdraw = async (): Promise<void> => {
    if (confirmation == null || busy) return
    setBusy(true)
    setError('')
    try {
      await client.withdrawFromGame(gameId, confirmation)
      setConfirmation(undefined)
      await load()
      onChanged()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Withdrawal could not be saved. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.section}>
      {canPropose && (
        <Button
          label="Propose game change"
          kind="secondary"
          onPress={() => {
            onEdit()
          }}
        />
      )}
      {teams.map(teamId => (
        <Button
          key={teamId}
          label={`Withdraw ${teamNames[teamId] ?? 'team'} from game`}
          kind="secondary"
          onPress={() => {
            setConfirmation(teamId)
          }}
        />
      ))}
      {confirmation != null && (
        <Card style={styles.card}>
          <Text style={styles.hint}>
            Withdraw {teamNames[confirmation] ?? 'this team'} now? The game
            stays on every schedule as canceled due to withdrawal. Existing
            scores, events and history stay preserved.
          </Text>
          <Button
            label="Confirm withdrawal"
            busy={busy}
            onPress={() => {
              withdraw().catch(() => undefined)
            }}
          />
          <Button
            label="Keep game"
            kind="secondary"
            disabled={busy}
            onPress={() => {
              setConfirmation(undefined)
            }}
          />
        </Card>
      )}
      {error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.5) },
  title: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  status: {
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
