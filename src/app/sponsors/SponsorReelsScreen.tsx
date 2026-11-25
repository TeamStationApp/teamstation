import React, { useRef, useState } from 'react'
import { Image, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  defaultScoreboardSettings,
  type SponsorOverlay
} from '../../common/nodeSettings'
import {
  allocationProblem,
  reelFileProblem,
  reelLengthProblem,
  remainingCredits
} from '../../common/sponsors/sponsorRules'
import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { boardPlaceSpace, reelRect } from '../player/sponsors/overlayRects'
import type { VideoHandle } from '../player/videoHandle'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CreditTable } from './CreditTable'
import { readVideoDuration } from './pickedFiles'
import { prepareMedia } from './prepareMedia'
import { SponsorFileDrop } from './SponsorFileDrop'
import { SponsorPreviewLayout } from './SponsorPreviewLayout'
import { SponsorReelPreview } from './SponsorReelPreview'
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

export interface SponsorReelsScreenProps {
  client: SponsorScreenClient
  /** The league's id. */
  league: string
  /** The league's store; the session's API store by default. */
  store?: SponsorStore
  /** For a test: how a recording sample is attached. */
  attachSample?: (handle: VideoHandle, url: string) => () => void
  /** For a test: how long a picked video is, in seconds. */
  readDuration?: (picked: PickedFile) => Promise<number>
  /** For a test: how a picked reel is shrunk. */
  prepare?: (
    purpose: SponsorMediaPurpose,
    picked: PickedFile
  ) => Promise<PreparedFile>
}

interface Pending {
  picked: PreparedFile
  durationSec: number
}

/**
 * A reel in the scoreboard's place over a single landscape camera, as the
 * players put it: the board's anchor, the node's landscape-1 reel size.
 */
function reelBox(overlay: SponsorOverlay): ReturnType<typeof boxOf> {
  return boxOf(
    reelRect(
      boardPlaceSpace(SAMPLE_FRAME, defaultScoreboardSettings.single),
      overlay.reel.landscape1,
      { width: SAMPLE_FRAME.w, height: SAMPLE_FRAME.h },
      16 / 9
    )
  )
}

const count = (value: number): string => value.toLocaleString('en-US')
const seconds = (value: number): string => `${Math.round(value * 10) / 10} s`

/**
 * Sponsor Video Reels: a league's 10–15 second sponsor reels, each with the
 * broadcasts it is allocated, previewed in the scoreboard's place over a
 * sample of the league's own video before it is accepted.
 */
export function SponsorReelsScreen({
  client,
  league,
  store: given,
  attachSample,
  readDuration = readVideoDuration,
  prepare = prepareMedia
}: SponsorReelsScreenProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const store = given ?? sponsorStoreFor(league, client)
  const admin = useLeagueAdmin(client, league)
  const state = useSponsorState(store)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [reading, setReading] = useState<'length' | 'shrinking' | null>(null)
  const [draft, setDraft] = useState('')
  const [acceptError, setAcceptError] = useState('')
  const [accepting, setAccepting] = useState(false)
  // The listed reel whose name was tapped, shown in the scoreboard's place.
  const [shownId, setShownId] = useState<string | null>(null)
  // Each pick's number, so a length read after a newer pick or a Cancel
  // is dropped.
  const picks = useRef(0)
  const confirm = useConfirmedAction(store, league)

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

  const total = state?.totals.reelCredits ?? 0
  const reels = state?.reels ?? []
  const left = remainingCredits(total, reels)
  const allocation = draft.trim() === '' ? NaN : Number(draft)
  const shownReel =
    shownId == null ? null : (reels.find(reel => reel.id === shownId) ?? null)
  const problem =
    pending != null
      ? allocationProblem(reels, total, null, allocation, 'broadcast')
      : null

  const refuse = (sentence: string): void => {
    setReading(null)
    setPickError(sentence)
    setPending(null)
  }
  const pick = async (picked: PickedFile): Promise<void> => {
    const turn = ++picks.current
    setAcceptError('')
    setPending(null)
    const refused = reelFileProblem(picked)
    if (refused != null) {
      refuse(refused)
      return
    }
    setPickError(null)
    setReading('length')
    let durationSec = NaN
    try {
      durationSec = await readDuration(picked)
    } catch {
      // An unreadable length is refused below.
    }
    if (turn !== picks.current) return
    const tooLong = reelLengthProblem(durationSec)
    if (tooLong != null) {
      refuse(tooLong)
      return
    }
    // Shrunk on this device: the server only checks what it is sent.
    setReading('shrinking')
    let prepared: PreparedFile
    try {
      prepared = await prepare('reel', { ...picked, durationSec })
    } catch (caught) {
      if (turn !== picks.current) return
      refuse(
        caught instanceof Error
          ? caught.message
          : 'This video could not be shrunk. Try another file.'
      )
      return
    }
    if (turn !== picks.current) return
    setReading(null)
    setDraft('')
    setPending({ picked: prepared, durationSec })
  }
  const cancel = (): void => {
    picks.current++
    setReading(null)
    setPending(null)
    setDraft('')
    setAcceptError('')
  }
  const accept = async (): Promise<void> => {
    if (pending == null) return
    setAccepting(true)
    setAcceptError('')
    try {
      await store.addReel({
        picked: pending.picked,
        durationSec: pending.durationSec,
        allocation
      })
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
          Sponsor Video Reels
        </Text>
        <Text style={styles.text}>
          Reels play in the scoreboard's place over a single landscape video.
        </Text>
        <Text style={styles.hint} testID="sponsor-reel-limits">
          Reels are 10 to 15 seconds long and 640 × 360. Larger videos are
          shrunk automatically to fit 640 × 360, keeping their proportions.
          After shrinking, a reel can be at most 3.2 MB.
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
                pending != null ? (
                  <OverlayAt
                    box={reelBox(overlay)}
                    testID="sponsor-reel-preview"
                  >
                    <SponsorReelPreview
                      url={pending.picked.url}
                      label={`Preview of ${pending.picked.name}`}
                      playing
                    />
                  </OverlayAt>
                ) : shownReel != null ? (
                  <OverlayAt
                    box={reelBox(overlay)}
                    testID="sponsor-reel-preview"
                  >
                    {shownReel.videoUrl !== '' ? (
                      <SponsorReelPreview
                        key={shownReel.id}
                        url={shownReel.videoUrl}
                        label={`Preview of ${shownReel.name}`}
                        playing
                      />
                    ) : (
                      <Image
                        source={{ uri: shownReel.posterUrl }}
                        accessibilityLabel={`Preview of ${shownReel.name}`}
                        resizeMode="cover"
                        style={StyleSheet.absoluteFill}
                      />
                    )}
                  </OverlayAt>
                ) : null
              }
            </SponsorSampleVideo>
          )}
          side={
            pending == null ? (
              <View style={styles.field}>
                <SponsorFileDrop
                  label="Add Reel"
                  prompt="Drop a video here or Choose file"
                  accept="video/*"
                  error={pickError}
                  onPick={picked => {
                    pick(picked).catch(() => undefined)
                  }}
                />
                {reading != null && (
                  <Text style={styles.hint}>
                    {reading === 'length'
                      ? "Reading the reel's length…"
                      : 'Shrinking the reel…'}
                  </Text>
                )}
              </View>
            ) : (
              <View style={styles.pending} testID="sponsor-reel-pending">
                <Text style={styles.label} numberOfLines={1}>
                  {pending.picked.name} · {seconds(pending.durationSec)}
                </Text>
                <View style={styles.field}>
                  <Text style={styles.label}>Broadcasts for this reel</Text>
                  <TextInput
                    accessibilityLabel="Broadcasts for this reel"
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
                    Up to {count(Math.max(0, left))} broadcast credits left
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
                    left <= 0 ? 'No broadcast credits left to assign' : 'Accept'
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
          headers={[
            'Video reel',
            'Broadcasts used',
            'Broadcasts remaining',
            'Action'
          ]}
          rows={reels}
          emptyHint="No reels yet. Add one above."
          renderPicture={reel =>
            reel.posterUrl !== '' ? (
              <Image
                source={{ uri: reel.posterUrl }}
                accessibilityLabel={`${reel.name} reel`}
                resizeMode="cover"
                style={styles.poster}
              />
            ) : (
              <View style={styles.poster}>
                <SponsorReelPreview
                  url={reel.videoUrl}
                  label={`${reel.name} reel`}
                  playing={false}
                />
              </View>
            )
          }
          renderDetail={reel => (
            <Text style={styles.hint}>{seconds(reel.durationSec)}</Text>
          )}
          onSelect={reel => {
            setShownId(reel.id)
          }}
          selectDisabled={pending != null}
          allocationProblem={(reel, value) =>
            allocationProblem(reels, total, reel.id, value, 'broadcast')
          }
          onSaveAllocation={async (reel, value) => {
            await store.setReelAllocation(reel.id, value)
          }}
          onDeactivate={reel => {
            confirm.open({
              title: `Deactivate ${reel.name}?`,
              detail:
                reel.used > 0
                  ? `${reel.name} has been shown in ${count(reel.used)} broadcasts, so it stays listed as inactive and its ${count(reel.allocation)} broadcast credits stay assigned.`
                  : `${reel.name} hasn't been shown in any broadcast, so it is removed and its ${count(reel.allocation)} broadcast credits return.`,
              label: 'Deactivate',
              testID: 'sponsor-confirm-deactivate',
              sheetLabel: `Deactivate ${reel.name}`,
              run: async () => {
                await store.deactivateReel(reel.id)
              }
            })
          }}
        />
        <Text style={styles.text} testID="sponsor-reel-note">
          Each broadcast reel will be evenly distributed across all videos
          recorded by your league. One broadcast credit is used at the beginning
          of each game and between each half-inning, until the allocated
          broadcast count is depleted.
        </Text>
        <Text style={styles.remaining} testID="sponsor-reel-remaining">
          Remaining reel broadcast credits: {count(left)} of {count(total)}
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
  poster: {
    width: theme.rem(4),
    height: theme.rem(2.25),
    borderRadius: theme.rem(0.375),
    overflow: 'hidden',
    backgroundColor: '#111'
  },
  remaining: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  }
}))
