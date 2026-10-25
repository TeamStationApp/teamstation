import React, { useMemo, useRef, useState } from 'react'
import { Pressable, Text, useWindowDimensions, View } from 'react-native'

import type { RosterEntry } from '../../common/api'
import { rosterError as rulesRefusal } from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { WarningSheet } from '../components/WarningSheet'
import { lstrings, sprintf } from '../locales/strings'
import { captureException } from '../sentrySdk'
import {
  decodeLineupQr,
  encodeLineupQr,
  LineupQrError,
  type LineupQrErrorReason
} from './lineupQrCodec'
import { lineupQrOf } from './lineupQrExport'
import { LineupQrGlyph } from './LineupQrGlyph'
import type { LineupQrGlyphKind } from './lineupQrGlyphs'
import {
  applyLineupQr,
  type CreateGuest,
  LineupQrGuestError,
  type LineupQrResult
} from './lineupQrImport'
import { QrCode } from './QrCode'
import {
  QrScanner,
  qrScannerSupported as platformScannerSupported
} from './qrScanner'
import type { QrScannerProps, QrScannerStatus } from './qrScannerProps'
import type { LineupQrOffer } from './scoringRosterEdit'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { ScoringTextInput } from './ScoringTextInput'
import type { ScoringSessionState, Side } from './scoringTypes'

type Step = 'choose' | 'share' | 'scan' | 'unsupported'
type Warning =
  | { reason: LineupQrErrorReason | 'denied' | 'guestFailed' }
  /** The game cannot take the scanned lineup now; the roster rules say why. */
  | { reason: 'refused'; problem: string }

/** About two inches on a phone: the camera's square on the scan step. */
export const SCANNER_SIZE = 280
const QR_MAX_SIZE = 320

/**
 * The Share Lineup QR's size in a window: as large as fits the card, up to
 * 320pt, by height as well as width, so the code and the sheet's Cancel stay
 * on screen in a short landscape window. The card's name, subtitle, Cancel,
 * padding and margins take about 240pt of height and 80pt of width.
 */
export function shareQrSize(width: number, height: number): number {
  return Math.max(120, Math.min(QR_MAX_SIZE, width - 80, height - 240))
}

/** Where a lineup QR sheet opens: a chooser, the code, or the camera. */
export function lineupQrOpeningStep(
  offer: LineupQrOffer,
  scannerSupported: boolean
): Step {
  if (offer === 'share') return 'share'
  if (offer === 'scan') return scannerSupported ? 'scan' : 'unsupported'
  return 'choose'
}

const warningText = (warning: Warning): string =>
  warning.reason === 'refused'
    ? sprintf(lstrings.lineupQr_refused, warning.problem)
    : {
        notLineup: lstrings.lineupQr_notLineup,
        wrongShape: lstrings.lineupQr_wrongShape,
        empty: lstrings.lineupQr_empty,
        denied: lstrings.lineupQr_cameraDenied,
        guestFailed: lstrings.lineupQr_guestFailed
      }[warning.reason]

// React Native's global; the web build and the test bundles define it too.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean | undefined
const developmentBuild = typeof __DEV__ === 'boolean' && __DEV__

/**
 * Share Lineup on the scorekeeper's roster screen. A scorekeeper of both
 * teams chooses, for the team on the Away/Home slider, between its lineup as
 * a GameChanger QR code and a camera that reads one into the roster draft. A
 * scorekeeper of one team opens straight on the code for his own team, or
 * straight on the camera for the opponent. Each step is a centered sheet
 * with the team's name over it and a red Cancel under it, which closes them
 * all; there is no going back a step.
 */
export function LineupShareSheet({
  side,
  offer = 'both',
  draft,
  game,
  nextBatter,
  roster,
  rosterLoading = false,
  rosterError,
  scanner: Scanner = QrScanner,
  scannerSupported = platformScannerSupported,
  devBuild = developmentBuild,
  onCreateGuest,
  onImport,
  onClose
}: {
  side: Side
  /** Share only, scan only, or the chooser. A one-team scorekeeper has no chooser. */
  offer?: LineupQrOffer
  draft: ScoringSessionState
  /**
   * The game the roster editor opened over. A scanned lineup the roster rules
   * would refuse against it (once the game has begun, a change that cannot be
   * read as substitutions) is not loaded; the warning says why.
   */
  game?: ScoringSessionState
  /** The next batter the scorer chose on the editor, when one is awaited. */
  nextBatter?: number
  /** The side's team roster, which a scanned player may already be on. */
  roster: readonly RosterEntry[]
  rosterLoading?: boolean
  rosterError?: string
  scanner?: React.ComponentType<QrScannerProps>
  scannerSupported?: boolean
  /** Whether to offer the payload field while a camera works too. */
  devBuild?: boolean
  /** Makes each scanned player who is not on the team a game-only guest. */
  onCreateGuest?: CreateGuest
  onImport: (result: LineupQrResult) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const { width, height } = useWindowDimensions()
  const [step, setStep] = useState<Step>(() =>
    lineupQrOpeningStep(offer, scannerSupported)
  )
  const [status, setStatus] = useState<QrScannerStatus | 'starting'>('starting')
  const [warning, setWarning] = useState<Warning>()
  const [payload, setPayload] = useState('')
  const imported = useRef(false)
  // A code is read once at a time; the camera keeps reporting it meanwhile.
  const reading = useRef(false)
  const guests = useRef(new Map<string, RosterEntry>())
  const teamName = draft.gameData.teams[side].name
  const qrText = useMemo(
    () => (step === 'share' ? encodeLineupQr(lineupQrOf(draft, side)) : ''),
    [draft, side, step]
  )
  const text = {
    fontFamily: theme.regularTextFont,
    color: theme.primaryTextColor,
    fontSize: 16
  }
  const subtitle = {
    choose: lstrings.lineupQr_chooserSubtitle,
    share: lstrings.lineupQr_shareSubtitle,
    scan: lstrings.lineupQr_importSubtitle,
    unsupported: lstrings.lineupQr_importSubtitle
  }[step]

  /**
   * What the roster rules would refuse in this lineup against the game. A
   * next batter still to be chosen is not a refusal: the scorer's pick is used
   * while it is in the order, and otherwise the first batter not on base,
   * whom the scorer can change on the editor once the lineup is loaded.
   */
  const refusal = (
    current: ScoringSessionState,
    candidate: ScoringSessionState
  ): string | undefined => {
    const order =
      candidate.liveData.boxscore.teams[battingSide(current)].battingOrder
    const onBase = baseIds(current)
    const next =
      nextBatter != null && order.includes(nextBatter)
        ? nextBatter
        : current.awaitingBatter == null
          ? nextBatter
          : order.find(id => !onBase.includes(id))
    return rulesRefusal(current, setupOf(candidate), next)
  }
  const read = async (code: string): Promise<void> => {
    if (warning != null || imported.current || reading.current) return
    reading.current = true
    let result: LineupQrResult
    try {
      result = await applyLineupQr(
        draft,
        side,
        decodeLineupQr(code),
        roster,
        onCreateGuest,
        guests.current
      )
    } catch (error) {
      if (error instanceof LineupQrGuestError) {
        setWarning({ reason: 'guestFailed' })
        return
      }
      if (!(error instanceof LineupQrError)) captureException(error)
      setWarning({
        reason: error instanceof LineupQrError ? error.reason : 'wrongShape'
      })
      return
    } finally {
      reading.current = false
    }
    if (game != null && refusal(game, draft) == null) {
      const problem = refusal(game, result.draft)
      if (problem != null) {
        setWarning({ reason: 'refused', problem })
        return
      }
    }
    imported.current = true
    onImport(result)
  }
  const row = (
    kind: LineupQrGlyphKind,
    label: string,
    onPress: () => void,
    disabled = false,
    note?: string
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.scoringSurface.divider,
        opacity: disabled ? 0.5 : 1
      }}
    >
      <LineupQrGlyph kind={kind} color={theme.primaryTextColor} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={text}>{label}</Text>
        {note != null && (
          <Text
            style={{
              ...text,
              fontSize: 13,
              color: theme.secondaryTextColor
            }}
          >
            {note}
          </Text>
        )}
      </View>
      <Text style={{ ...text, color: theme.scoringSurface.chevronActive }}>
        ›
      </Text>
    </Pressable>
  )
  const showPayload = devBuild || status === 'unavailable'
  const scanHeld = rosterLoading || rosterError != null

  return (
    <ScoringSheet
      title={teamName}
      placement="center"
      headerless
      scroll={false}
      onClose={onClose}
    >
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ alignItems: 'center', gap: 2 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              ...text,
              fontFamily: theme.boldTextFont,
              fontWeight: '700',
              fontSize: 18,
              textAlign: 'center'
            }}
          >
            {teamName}
          </Text>
          <Text
            style={{
              ...text,
              fontSize: 14,
              color: theme.secondaryTextColor,
              textAlign: 'center'
            }}
          >
            {subtitle}
          </Text>
        </View>
        {step === 'choose' && (
          <View>
            {row('qr', lstrings.lineupQr_generate, () => {
              setStep('share')
            })}
            {row(
              'scan',
              lstrings.lineupQr_scan,
              () => {
                setStep(scannerSupported ? 'scan' : 'unsupported')
              },
              rosterLoading || rosterError != null,
              rosterLoading ? lstrings.lineupQr_rosterLoading : rosterError
            )}
          </View>
        )}
        {step === 'share' && (
          <View style={{ alignItems: 'center' }}>
            <QrCode
              text={qrText}
              size={shareQrSize(width, height)}
              accessibilityLabel={lstrings.lineupQr_qrLabel}
            />
          </View>
        )}
        {step === 'scan' && scanHeld && (
          <Text
            accessibilityRole="text"
            style={{
              ...text,
              fontSize: 14,
              color: theme.secondaryTextColor,
              textAlign: 'center'
            }}
          >
            {rosterLoading ? lstrings.lineupQr_rosterLoading : rosterError}
          </Text>
        )}
        {step === 'scan' && !scanHeld && (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <View
              testID="lineupQrScanner"
              accessible
              accessibilityLabel={sprintf(lstrings.lineupQr_camera, status)}
              style={{
                width: SCANNER_SIZE,
                height: SCANNER_SIZE,
                backgroundColor: '#000000',
                overflow: 'hidden'
              }}
            >
              <Scanner
                active={warning == null}
                onCode={code => {
                  read(code).catch(captureException)
                }}
                onStatus={next => {
                  setStatus(next)
                  if (next === 'denied') setWarning({ reason: 'denied' })
                }}
              />
              <View
                pointerEvents="none"
                style={{ position: 'absolute', left: 0, top: 0 }}
              >
                <LineupQrGlyph
                  kind="scan"
                  color={theme.successColor}
                  size={SCANNER_SIZE}
                  strokeWidth={1}
                />
              </View>
            </View>
            {status === 'unavailable' && (
              <Text
                accessibilityRole="text"
                style={{
                  ...text,
                  fontSize: 14,
                  color: theme.secondaryTextColor,
                  textAlign: 'center'
                }}
              >
                {lstrings.lineupQr_cameraUnavailable}
              </Text>
            )}
            {showPayload && (
              <View style={{ alignSelf: 'stretch', gap: 8 }}>
                <ScoringTextInput
                  testID="lineupQrPayload"
                  accessibilityLabel={lstrings.lineupQr_payload}
                  placeholder={lstrings.lineupQr_payload}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={payload}
                  onChangeText={setPayload}
                />
                <Button
                  compact
                  color={theme.scoringMenuActiveBackground}
                  textColor={theme.scoringMenuActiveText}
                  accessibilityLabel={lstrings.lineupQr_inject}
                  label={lstrings.lineupQr_inject}
                  disabled={payload.trim() === ''}
                  onPress={() => {
                    read(payload).catch(captureException)
                  }}
                />
              </View>
            )}
          </View>
        )}
        {step === 'unsupported' && (
          <Text
            accessibilityRole="alert"
            style={{ ...text, textAlign: 'center' }}
          >
            {lstrings.lineupQr_unsupportedWeb}
          </Text>
        )}
        <CancelAction accessibilityLabel="Cancel" onPress={onClose} />
      </View>
      {warning != null && (
        <WarningSheet
          message={warningText(warning)}
          actionLabel={lstrings.lineupQr_scanAgain}
          onAction={() => {
            setWarning(undefined)
          }}
          onClose={() => {
            setWarning(undefined)
          }}
        />
      )}
    </ScoringSheet>
  )
}
