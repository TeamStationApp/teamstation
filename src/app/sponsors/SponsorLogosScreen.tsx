import React, { useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, Text, TextInput, View } from 'react-native'

import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useConfirmedAction } from '../components/useConfirmedAction'
import type { VideoHandle } from '../player/videoHandle'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CreditTable } from './CreditTable'
import { DemoDataBar } from './DemoDataBar'
import { logoBox } from './overlayBoxes'
import { pickedFileOf } from './pickedFiles'
import type { SampleClient, SampleRecording } from './sampleRecording'
import { SponsorFileDrop } from './SponsorFileDrop'
import {
  allocationProblem,
  logoFileProblem,
  remainingCredits
} from './sponsorRules'
import { OverlayAt, SponsorSampleVideo } from './SponsorSampleVideo'
import { type SponsorStore, sponsorStoreFor } from './sponsorStore'
import type { PickedFile, SponsorLogo } from './sponsorTypes'
import { useLeagueAdmin } from './useLeagueAdmin'
import { useSponsorState } from './useSponsorState'

export interface SponsorLogosScreenProps {
  client: SampleClient
  /** The league's id. */
  league: string
  /** The league's store; its page-long mock by default. */
  store?: SponsorStore
  /** For a test: how the sample video is found and attached. */
  findSample?: (client: SampleClient, id: string) => Promise<SampleRecording>
  attachSample?: (handle: VideoHandle, url: string) => () => void
}

type Pending =
  | { mode: 'add'; picked: PickedFile }
  | { mode: 'change'; picked: PickedFile; logo: SponsorLogo }

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
  findSample,
  attachSample
}: SponsorLogosScreenProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const store = given ?? sponsorStoreFor(league)
  const admin = useLeagueAdmin(client, league)
  const state = useSponsorState(store)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [acceptError, setAcceptError] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const changeInput = useRef<HTMLInputElement>(null)
  const changing = useRef<SponsorLogo | null>(null)
  const confirm = useConfirmedAction(store, league)

  const pendingUrl = pending?.picked.url
  useEffect(() => {
    setSize({ width: 1, height: 1 })
    if (pendingUrl == null) return
    let live = true
    Image.getSize(
      pendingUrl,
      (width, height) => {
        if (live) setSize({ width, height })
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [pendingUrl])

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
  const logos = state?.logos ?? []
  const left = remainingCredits(total, logos)
  const allocation = draft.trim() === '' ? NaN : Number(draft)
  const problem =
    pending?.mode === 'add'
      ? allocationProblem(logos, total, null, allocation, 'game logo')
      : null

  const pick = (picked: PickedFile, logo: SponsorLogo | null): void => {
    const refused = logoFileProblem(picked)
    setAcceptError('')
    if (refused != null) {
      setPickError(refused)
      setPending(null)
      return
    }
    setPickError(null)
    setDraft('')
    setPending(
      logo == null ? { mode: 'add', picked } : { mode: 'change', picked, logo }
    )
  }
  const cancel = (): void => {
    setPending(null)
    setDraft('')
    setAcceptError('')
  }
  const accept = async (): Promise<void> => {
    if (pending == null) return
    setAccepting(true)
    setAcceptError('')
    try {
      if (pending.mode === 'add')
        await store.addLogo({ picked: pending.picked, allocation })
      else await store.changeLogo(pending.logo.id, pending.picked)
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
        <SponsorSampleVideo
          client={client}
          leagueId={league}
          find={findSample}
          attach={attachSample}
        >
          {pending != null && (
            <OverlayAt box={logoBox(size)} testID="sponsor-logo-preview">
              <Image
                source={{ uri: pending.picked.url }}
                accessibilityLabel={`Preview of ${pending.picked.name}`}
                resizeMode="contain"
                style={StyleSheet.absoluteFill}
              />
            </OverlayAt>
          )}
        </SponsorSampleVideo>
        {pending == null ? (
          <SponsorFileDrop
            label="Add Logo"
            prompt="Drop a PNG here or Choose file"
            accept="image/png"
            error={pickError}
            onPick={picked => {
              pick(picked, null)
            }}
          />
        ) : (
          <View style={styles.pending} testID="sponsor-logo-pending">
            {pending.mode === 'add' ? (
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
            ) : (
              <Text style={styles.hint}>
                Games already assigned {pending.logo.name} keep the version they
                had.
              </Text>
            )}
            {acceptError !== '' && (
              <Text accessibilityRole="alert" style={styles.error}>
                {acceptError}
              </Text>
            )}
            <Button
              label={
                pending.mode === 'add' && left <= 0
                  ? 'No game logo credits left to assign'
                  : 'Accept'
              }
              block
              busy={accepting}
              disabled={
                accepting ||
                (pending.mode === 'add' && (left <= 0 || problem != null))
              }
              onPress={() => {
                accept().catch(() => undefined)
              }}
            />
            <CancelAction onPress={cancel} />
          </View>
        )}
        <CreditTable
          headers={['Logo', 'Games used', 'Games remaining', 'Action']}
          rows={logos}
          allocationLabel="Games allocated"
          changeLabel="Change Logo"
          emptyHint="No logos yet. Add one above."
          renderItem={logo => (
            <View style={styles.item}>
              <Image
                source={{ uri: logo.imageUrl }}
                accessibilityLabel={`${logo.name} logo`}
                resizeMode="contain"
                style={styles.tile}
              />
              <Text style={styles.itemName} numberOfLines={2}>
                {logo.name}
              </Text>
            </View>
          )}
          allocationProblem={(logo, value) =>
            allocationProblem(logos, total, logo.id, value, 'game logo')
          }
          onSaveAllocation={async (logo, value) => {
            await store.setLogoAllocation(logo.id, value)
          }}
          onChange={logo => {
            changing.current = logo
            changeInput.current?.click()
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
        <input
          ref={changeInput}
          type="file"
          accept="image/png"
          aria-label="Change Logo file"
          data-testid="sponsor-change-input"
          style={{ display: 'none' }}
          onChange={event => {
            const target = event.currentTarget
            const file = target.files?.[0]
            const logo = changing.current
            target.value = ''
            if (file != null && logo != null) pick(pickedFileOf(file), logo)
          }}
        />
        <Text style={styles.remaining} testID="sponsor-logo-remaining">
          Remaining game logo credits: {count(left)} of {count(total)}
        </Text>
        <DemoDataBar store={store} onReset={cancel} />
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
  item: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.rem(0.5),
    minWidth: 0
  },
  tile: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(0.375)
  },
  itemName: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  remaining: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  }
}))
