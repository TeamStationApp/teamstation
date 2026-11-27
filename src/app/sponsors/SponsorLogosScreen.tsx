import React, { useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  allocationProblem,
  logoFileProblem,
  remainingCredits
} from '../../common/sponsors/sponsorRules'
import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { logoRect } from '../player/sponsors/overlayRects'
import type { VideoHandle } from '../player/videoHandle'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CreditTable } from './CreditTable'
import { prepareMedia } from './prepareMedia'
import { SponsorFileDrop } from './SponsorFileDrop'
import { SponsorPreviewLayout } from './SponsorPreviewLayout'
import { OverlayAt, SponsorSampleVideo } from './SponsorSampleVideo'
import {
  type SponsorScreenClient,
  type SponsorStore,
  sponsorStoreFor
} from './sponsorStore'
import type {
  PickedFile,
  PreparedFile,
  SponsorMediaPurpose
} from './sponsorTypes'
import { useLeagueAdmin } from './useLeagueAdmin'
import { boxOf, SAMPLE_FRAME } from './useSponsorSample'
import { useSponsorState } from './useSponsorState'

export interface SponsorLogosScreenProps {
  client: SponsorScreenClient
  /** The league's id. */
  league: string
  /** The league's store; the session's API store by default. */
  store?: SponsorStore
  /** For a test: how a recording sample is attached. */
  attachSample?: (handle: VideoHandle, url: string) => () => void
  /** For a test: how a picked logo is shrunk. */
  prepare?: (
    purpose: SponsorMediaPurpose,
    picked: PickedFile
  ) => Promise<PreparedFile>
}

interface Pending {
  picked: PreparedFile
}

const count = (value: number): string => value.toLocaleString('en-US')

/**
 * Sponsor Video Logos: a league's sponsor logos, each with the games it is
 * allocated, previewed in the upper-right over a sample of the league's
 * own video before it is accepted.
 */
export function SponsorLogosScreen({
  client,
  league,
  store: given,
  attachSample,
  prepare = prepareMedia
}: SponsorLogosScreenProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const store = given ?? sponsorStoreFor(league, client)
  const admin = useLeagueAdmin(client, league)
  const state = useSponsorState(store)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [shrinking, setShrinking] = useState(false)
  // Each pick's number, so a logo shrunk after a newer pick is dropped.
  const picks = useRef(0)
  const [draft, setDraft] = useState('')
  const [acceptError, setAcceptError] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [size, setSize] = useState({ width: 1, height: 1 })
  // The listed logo whose name was tapped, shown over the sample.
  const [shownId, setShownId] = useState<string | null>(null)
  const confirm = useConfirmedAction(store, league)

  const logos = state?.logos ?? []
  const shownLogo =
    shownId == null ? null : (logos.find(logo => logo.id === shownId) ?? null)
  const previewUrl = pending?.picked.url ?? shownLogo?.imageUrl
  const previewName = pending?.picked.name ?? shownLogo?.name
  const pendingSize =
    pending == null
      ? null
      : { width: pending.picked.width, height: pending.picked.height }
  useEffect(() => {
    setSize({ width: 1, height: 1 })
    if (previewUrl == null || pending != null) return
    let live = true
    Image.getSize(
      previewUrl,
      (width, height) => {
        if (live) setSize({ width, height })
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [previewUrl, pending])

  if (admin === 'loading')
    return (
      <Screen>
        <Text style={styles.hint}>Loading…</Text>
      </Screen>
    )
  if (admin !== 'admin')
    return (
      <Screen>
        <View style={styles.page}>
          <Text style={styles.text}>
            Only a league administrator can set up sponsor features.
          </Text>
        </View>
      </Screen>
    )

  const total = state?.totals.logoCredits ?? 0
  const left = remainingCredits(total, logos)
  const allocation = draft.trim() === '' ? NaN : Number(draft)
  const problem =
    pending != null
      ? allocationProblem(logos, total, null, allocation, 'game logo')
      : null

  const pick = async (picked: PickedFile): Promise<void> => {
    const turn = ++picks.current
    const refused = logoFileProblem(picked)
    setAcceptError('')
    setPending(null)
    if (refused != null) {
      setPickError(refused)
      return
    }
    setPickError(null)
    setShrinking(true)
    try {
      const prepared = await prepare('logo', picked)
      if (turn !== picks.current) return
      setDraft('')
      setPending({ picked: prepared })
    } catch (caught) {
      if (turn !== picks.current) return
      setPickError(
        caught instanceof Error
          ? caught.message
          : 'This picture could not be read. Try another file.'
      )
    } finally {
      if (turn === picks.current) setShrinking(false)
    }
  }
  const cancel = (): void => {
    picks.current++
    setShrinking(false)
    setPending(null)
    setDraft('')
    setAcceptError('')
  }
  const accept = async (): Promise<void> => {
    if (pending == null) return
    setAccepting(true)
    setAcceptError('')
    try {
      await store.addLogo({ picked: pending.picked, allocation })
      cancel()
    } catch (caught) {
      setAcceptError(
        caught instanceof Error ? caught.message : 'That could not be saved.'
      )
    } finally {
      setAccepting(false)
    }
  }

  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Sponsor Video Logos
        </Text>
        <Text style={styles.text}>
          Your sponsor logo appears in the upper-right of every applicable game
          video, overlaid during playback on Apple TV, web, and mobile.
        </Text>
        <SponsorPreviewLayout
          video={fill => (
            <SponsorSampleVideo
              client={client}
              leagueId={league}
              attach={attachSample}
              fill={fill}
            >
              {overlay =>
                previewUrl != null && (
                  <OverlayAt
                    box={boxOf(
                      logoRect(
                        SAMPLE_FRAME,
                        overlay.logo.single,
                        pendingSize ?? size
                      )
                    )}
                    testID="sponsor-logo-preview"
                  >
                    <Image
                      source={{ uri: previewUrl }}
                      accessibilityLabel={`Preview of ${previewName ?? 'logo'}`}
                      resizeMode="contain"
                      style={StyleSheet.absoluteFill}
                    />
                  </OverlayAt>
                )
              }
            </SponsorSampleVideo>
          )}
          side={
            pending == null ? (
              <View style={styles.field}>
                <SponsorFileDrop
                  label="Add Logo"
                  prompt="Drop a PNG here or Choose file"
                  accept="image/png"
                  error={pickError}
                  onPick={picked => {
                    pick(picked).catch(() => undefined)
                  }}
                />
                {shrinking && (
                  <Text style={styles.hint}>Preparing the logo…</Text>
                )}
              </View>
            ) : (
              <View style={styles.pending} testID="sponsor-logo-pending">
                <View style={styles.field}>
                  <Text style={styles.label}>Credits for this logo</Text>
                  <TextInput
                    accessibilityLabel="Credits for this logo"
                    value={draft}
                    inputMode="numeric"
                    keyboardType="number-pad"
                    style={styles.input}
                    onChangeText={text => {
                      setAcceptError('')
                      setDraft(text.replace(/[^0-9]/g, ''))
                    }}
                  />
                  <Text style={styles.hint}>
                    Up to {count(Math.max(0, left))} game logo credits left
                  </Text>
                  {draft !== '' && problem != null && (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {problem}
                    </Text>
                  )}
                </View>
                {acceptError !== '' && (
                  <Text accessibilityRole="alert" style={styles.error}>
                    {acceptError}
                  </Text>
                )}
                <Button
                  label={
                    left <= 0 ? 'No game logo credits left to assign' : 'Accept'
                  }
                  block
                  busy={accepting}
                  disabled={accepting || left <= 0 || problem != null}
                  onPress={() => {
                    accept().catch(() => undefined)
                  }}
                />
                <CancelAction onPress={cancel} />
              </View>
            )
          }
        />
        <CreditTable
          headers={['Logo', 'Games used', 'Games remaining', 'Action']}
          rows={logos}
          emptyHint="No logos yet. Add one above."
          renderPicture={logo => (
            <Image
              source={{ uri: logo.imageUrl }}
              accessibilityLabel={`${logo.name} logo`}
              resizeMode="contain"
              style={styles.tile}
            />
          )}
          onSelect={logo => {
            setShownId(logo.id)
          }}
          selectDisabled={pending != null}
          allocationProblem={(logo, value) =>
            allocationProblem(logos, total, logo.id, value, 'game logo')
          }
          onSaveAllocation={async (logo, value) => {
            await store.setLogoAllocation(logo.id, value)
          }}
          onDeactivate={logo => {
            confirm.open({
              title: `Deactivate ${logo.name}?`,
              detail:
                logo.used > 0
                  ? `${logo.name} has been shown in ${count(logo.used)} games, so it stays listed as inactive and its ${count(logo.allocation)} game logo credits stay assigned.`
                  : `${logo.name} hasn't been shown in any game, so it is removed and its ${count(logo.allocation)} game logo credits return.`,
              label: 'Deactivate',
              testID: 'sponsor-confirm-deactivate',
              sheetLabel: `Deactivate ${logo.name}`,
              run: async () => {
                await store.deactivateLogo(logo.id)
              }
            })
          }}
        />
        <Text style={styles.remaining} testID="sponsor-logo-remaining">
          Remaining game logo credits: {count(left)} of {count(total)}
        </Text>
        <Text style={styles.text} testID="sponsor-logo-note">
          One logo is displayed per game. One logo credit is used for each game
          a logo is displayed in, and the credit is deducted only if the game is
          at least 30 minutes long.
        </Text>
      </View>
      {confirm.sheet}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingVertical: theme.rem(1) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  text: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.4)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  pending: {
    gap: theme.rem(0.75),
    padding: theme.rem(1),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  field: { gap: theme.rem(0.375) },
  label: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  input: {
    minHeight: 48,
    maxWidth: theme.rem(12),
    paddingHorizontal: theme.rem(0.75),
    borderRadius: theme.rem(0.5),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  tile: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(0.375)
  },
  remaining: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  }
}))
