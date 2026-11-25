import React, { useRef, useState } from 'react'
import { Image, Text, TextInput, View } from 'react-native'

import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useConfirmedAction } from '../components/useConfirmedAction'
import type { VideoHandle } from '../player/videoHandle'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CreditTable } from './CreditTable'
import { DemoDataBar } from './DemoDataBar'
import { reelBox } from './overlayBoxes'
import { pickedFileOf, readVideoDuration } from './pickedFiles'
import type { SampleClient, SampleRecording } from './sampleRecording'
import { SponsorFileDrop } from './SponsorFileDrop'
import {
  allocationProblem,
  reelFileProblem,
  reelLengthProblem,
  remainingCredits
} from './sponsorRules'
import { OverlayAt, SponsorSampleVideo } from './SponsorSampleVideo'
import { type SponsorStore, sponsorStoreFor } from './sponsorStore'
import type { PickedFile, SponsorReel } from './sponsorTypes'
import { useLeagueAdmin } from './useLeagueAdmin'
import { useSponsorState } from './useSponsorState'

export interface SponsorReelsScreenProps {
  client: SampleClient
  /** The league's id. */
  league: string
  /** The league's store; its page-long mock by default. */
  store?: SponsorStore
  /** For a test: how the sample video is found and attached. */
  findSample?: (client: SampleClient, id: string) => Promise<SampleRecording>
  attachSample?: (handle: VideoHandle, url: string) => () => void
  /** For a test: how long a picked video is, in seconds. */
  readDuration?: (picked: PickedFile) => Promise<number>
}

type Pending =
  | { mode: 'add'; picked: PickedFile; durationSec: number }
  | {
      mode: 'change'
      picked: PickedFile
      durationSec: number
      reel: SponsorReel
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
  findSample,
  attachSample,
  readDuration = readVideoDuration
}: SponsorReelsScreenProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const store = given ?? sponsorStoreFor(league)
  const admin = useLeagueAdmin(client, league)
  const state = useSponsorState(store)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [draft, setDraft] = useState('')
  const [acceptError, setAcceptError] = useState('')
  const [accepting, setAccepting] = useState(false)
  const changeInput = useRef<HTMLInputElement>(null)
  const changing = useRef<SponsorReel | null>(null)
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
  const problem =
    pending?.mode === 'add'
      ? allocationProblem(reels, total, null, allocation, 'broadcast')
      : null

  const refuse = (sentence: string): void => {
    setReading(false)
    setPickError(sentence)
    setPending(null)
  }
  const pick = async (
    picked: PickedFile,
    reel: SponsorReel | null
  ): Promise<void> => {
    const turn = ++picks.current
    setAcceptError('')
    setPending(null)
    const refused = reelFileProblem(picked)
    if (refused != null) {
      refuse(refused)
      return
    }
    setPickError(null)
    setReading(true)
    let durationSec = NaN
    try {
      durationSec = await readDuration(picked)
    } catch {
      // An unreadable length is refused below.
    }
    if (turn !== picks.current) return
    setReading(false)
    const tooLong = reelLengthProblem(durationSec)
    if (tooLong != null) {
      refuse(tooLong)
      return
    }
    setDraft('')
    setPending(
      reel == null
        ? { mode: 'add', picked, durationSec }
        : { mode: 'change', picked, durationSec, reel }
    )
  }
  const cancel = (): void => {
    picks.current++
    setReading(false)
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
        await store.addReel({
          picked: pending.picked,
          durationSec: pending.durationSec,
          allocation
        })
      else
        await store.changeReel(
          pending.reel.id,
          pending.picked,
          pending.durationSec
        )
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
        <SponsorSampleVideo
          client={client}
          leagueId={league}
          find={findSample}
          attach={attachSample}
        >
          {pending != null && (
            <OverlayAt box={reelBox()} testID="sponsor-reel-preview">
              <video
                src={pending.picked.url}
                aria-label={`Preview of ${pending.picked.name}`}
                muted
                loop
                autoPlay
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </OverlayAt>
          )}
        </SponsorSampleVideo>
        {pending == null ? (
          <View style={styles.field}>
            <SponsorFileDrop
              label="Add Reel"
              prompt="Drop a video here or Choose file"
              accept="video/*"
              error={pickError}
              onPick={picked => {
                pick(picked, null).catch(() => undefined)
              }}
            />
            {reading && (
              <Text style={styles.hint}>Reading the reel's length…</Text>
            )}
          </View>
        ) : (
          <View style={styles.pending} testID="sponsor-reel-pending">
            <Text style={styles.label}>
              {pending.picked.name} · {seconds(pending.durationSec)}
            </Text>
            {pending.mode === 'add' ? (
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
            ) : (
              <Text style={styles.hint}>
                Broadcasts already assigned {pending.reel.name} keep the version
                they had.
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
                  ? 'No broadcast credits left to assign'
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
          headers={[
            'Video reel',
            'Broadcasts used',
            'Broadcasts remaining',
            'Action'
          ]}
          rows={reels}
          allocationLabel="Broadcasts allocated"
          changeLabel="Change Reel"
          emptyHint="No reels yet. Add one above."
          renderItem={reel => (
            <View style={styles.item}>
              {reel.posterUrl !== '' ? (
                <Image
                  source={{ uri: reel.posterUrl }}
                  accessibilityLabel={`${reel.name} reel`}
                  resizeMode="cover"
                  style={styles.poster}
                />
              ) : (
                <View style={styles.poster}>
                  <video
                    src={reel.videoUrl}
                    aria-label={`${reel.name} reel`}
                    muted
                    playsInline
                    preload="metadata"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                </View>
              )}
              <View style={styles.itemText}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {reel.name}
                </Text>
                <Text style={styles.hint}>{seconds(reel.durationSec)}</Text>
              </View>
            </View>
          )}
          allocationProblem={(reel, value) =>
            allocationProblem(reels, total, reel.id, value, 'broadcast')
          }
          onSaveAllocation={async (reel, value) => {
            await store.setReelAllocation(reel.id, value)
          }}
          onChange={reel => {
            changing.current = reel
            changeInput.current?.click()
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
        <input
          ref={changeInput}
          type="file"
          accept="video/*"
          aria-label="Change Reel file"
          data-testid="sponsor-change-input"
          style={{ display: 'none' }}
          onChange={event => {
            const target = event.currentTarget
            const file = target.files?.[0]
            const reel = changing.current
            target.value = ''
            if (file != null && reel != null)
              pick(pickedFileOf(file), reel).catch(() => undefined)
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
  poster: {
    width: theme.rem(4),
    height: theme.rem(2.25),
    borderRadius: theme.rem(0.375),
    overflow: 'hidden',
    backgroundColor: '#111'
  },
  itemText: { flexShrink: 1, minWidth: 0 },
  itemName: {
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
