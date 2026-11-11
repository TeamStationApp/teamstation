import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { shortName } from '../../common/names'
import { CancelAction } from '../components/CancelAction'
import { ListCard } from '../components/ListCard'
import { PickerDialog } from '../components/PickerDialog'
import { SegmentedPill } from '../components/SegmentedPill'
import { Wheel } from '../components/Wheel'
import { ScopedThemeProvider, useTheme } from '../theme/ThemeContext'
import { BatIcon } from './BatIcon'
import { OverrideCountSlider } from './OverrideCountSlider'
import { overrideDraftOf, overrideHalf } from './overrideModel'
import { overrideProblem } from './scoringMachine'
import { ScoringButton, ScoringError, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { ScoringTextInput } from './ScoringTextInput'
import type { OverrideDraft, ScoringState } from './scoringTypes'

type NumberField = 'inning' | 'awayScore' | 'homeScore'

export function OverridesEditor({
  state,
  onApply,
  onClose,
  visible = true,
  applyAttempt = 0
}: {
  state: ScoringState
  onClose: () => void
  visible?: boolean
  applyAttempt?: number
  onApply: (draft: OverrideDraft) => void
}): React.ReactElement {
  const applying = useRef(false)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    applying.current = false
    setPending(false)
  }, [applyAttempt])
  const theme = useScoringSheetTheme()
  const controlsTheme = useMemo(
    () => ({
      ...theme,
      // Divider ends follow the rows' 12-point text inset on both sides.
      cardContentInsetRem: 12 / theme.rem(1),
      sliderTrackBackground:
        theme.scoringSheet === true
          ? theme.scoringSurface.input
          : theme.sliderTrackBackground,
      pillTextColor: theme.primaryTextColor
    }),
    [theme]
  )
  const [draft, setDraft] = useState<OverrideDraft>(() =>
    overrideDraftOf(state.session)
  )
  const [picker, setPicker] = useState<NumberField | null>(null)
  const [batters, setBatters] = useState(false)
  const [runnerBase, setRunnerBase] = useState<number | null>(null)
  const session = state.session
  const team = session.liveData.boxscore.teams[draft.top ? 'away' : 'home']
  const error = useMemo(() => overrideProblem(state, draft), [state, draft])
  const labels = {
    inning: 'Inning',
    awayScore: session.gameData.teams.away.name,
    homeScore: session.gameData.teams.home.name
  }
  const batter = draft.pinchHitter ?? draft.batter
  const name =
    batter == null
      ? 'Choose batter'
      : shortName({
          id: batter,
          displayName: session.gameData.players[batter].fullName
        })
  const textStyle = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 16
  }
  const rowStyle = {
    minHeight: 56,
    paddingHorizontal: 12,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    gap: 8
  }
  const labelStyle = { ...textStyle, flexShrink: 1 }
  const valueStyle = {
    ...textStyle,
    color: theme.scoringSheet === true ? '#90caf9' : theme.linkTextColor,
    fontFamily: theme.semiBoldTextFont
  }
  const selectBatter = (id: number, index: number, pinch: boolean): void => {
    setDraft(
      pinch
        ? { ...draft, pinchHitter: id }
        : { ...draft, batter: id, batterIndex: index, pinchHitter: undefined }
    )
    setBatters(false)
  }
  const playerRow = (
    id: number,
    index: number,
    pinch = false
  ): React.ReactElement => {
    const player = session.gameData.players[id]
    const base = draft.bases.indexOf(id)
    const disabled = base >= 0 || (pinch && draft.batter == null)
    const selected = id === batter && (pinch || index === draft.batterIndex)
    const label = `${pinch ? '' : `${index + 1}. `}${player.fullName}${player.jersey === '' ? '' : ` #${player.jersey}`}`
    return (
      <Pressable
        key={`${pinch ? 'bench' : 'order'}-${index}-${id}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, selected }}
        disabled={disabled}
        onPress={() => {
          selectBatter(id, index, pinch)
        }}
        style={[rowStyle, { opacity: disabled ? 0.45 : 1 }]}
      >
        <Text style={{ ...textStyle, flex: 1 }}>{label}</Text>
        {base >= 0 ? (
          <RunnerBases base={base} />
        ) : selected ? (
          <BatIcon label="Current batter" color={theme.primaryTextColor} />
        ) : null}
      </Pressable>
    )
  }
  return (
    <ScoringSheet
      title="Overrides"
      visible={visible}
      onClose={onClose}
      footer={
        <View style={{ gap: 12 }}>
          <ScoringError message={error} />
          <ScoringButton
            label="Apply Override"
            disabled={error != null || pending}
            onPress={() => {
              if (applying.current) return
              applying.current = true
              setPending(true)
              onApply(draft)
            }}
          />
        </View>
      }
    >
      <ScopedThemeProvider theme={controlsTheme}>
        <View style={{ gap: 12 }}>
          <SegmentedPill
            accessibilityLabel="Half inning"
            options={[
              { id: 'top', label: 'Top' },
              { id: 'bottom', label: 'Bottom' }
            ]}
            selected={draft.top ? 'top' : 'bottom'}
            onSelect={half => {
              setDraft(overrideHalf(session, draft, half === 'top'))
            }}
          />
          <ListCard>
            {(['inning', 'awayScore', 'homeScore'] as const).map(key => (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={
                  key === 'inning' ? 'Inning' : `${labels[key]} score`
                }
                onPress={() => {
                  setPicker(key)
                }}
                style={rowStyle}
              >
                <Text style={labelStyle}>{labels[key]}</Text>
                <Text style={valueStyle}>{draft[key]}</Text>
              </Pressable>
            ))}
            {(['balls', 'strikes', 'outs'] as const).map(key => {
              const label = key[0].toUpperCase() + key.slice(1)
              return (
                <View key={key} style={rowStyle}>
                  <Text style={labelStyle}>{label}</Text>
                  <OverrideCountSlider
                    label={label}
                    max={key === 'balls' ? 3 : 2}
                    value={draft[key]}
                    onChange={value => {
                      setDraft({ ...draft, [key]: value })
                    }}
                  />
                </View>
              )
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Batter"
              onPress={() => {
                setBatters(true)
              }}
              style={rowStyle}
            >
              <Text style={labelStyle}>Batter</Text>
              <Text style={[valueStyle, { flexShrink: 1, textAlign: 'right' }]}>
                {name}
              </Text>
            </Pressable>
            {['First base', 'Second base', 'Third base'].map((label, index) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => {
                  setRunnerBase(index)
                }}
                style={rowStyle}
              >
                <Text style={labelStyle}>{label}</Text>
                <Text
                  style={[valueStyle, { flexShrink: 1, textAlign: 'right' }]}
                >
                  {draft.bases[index] == null
                    ? 'Empty'
                    : session.gameData.players[draft.bases[index]].fullName}
                </Text>
              </Pressable>
            ))}
          </ListCard>
          {picker != null && (
            <OverrideNumberPicker
              label={picker === 'inning' ? 'Inning' : `${labels[picker]} score`}
              value={draft[picker]}
              inning={picker === 'inning'}
              onClose={() => {
                setPicker(null)
              }}
              onDone={value => {
                setDraft({ ...draft, [picker]: value })
                setPicker(null)
              }}
            />
          )}
          {runnerBase != null && (
            <ScoringSheet
              fullScreen
              title={['First base', 'Second base', 'Third base'][runnerBase]}
              onClose={() => {
                setRunnerBase(null)
              }}
            >
              <ListCard>
                {[null, ...team.players].map(id => {
                  const player =
                    id == null ? null : session.gameData.players[id]
                  const label =
                    player == null
                      ? 'Empty'
                      : `${player.fullName}${player.jersey === '' ? '' : ` #${player.jersey}`}`
                  const disabled =
                    id != null &&
                    (id === draft.batter || id === draft.pinchHitter)
                  return (
                    <Pressable
                      key={id ?? 'empty'}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose ${['First base', 'Second base', 'Third base'][runnerBase]} ${label}`}
                      accessibilityState={{
                        disabled,
                        selected: draft.bases[runnerBase] === id
                      }}
                      disabled={disabled}
                      onPress={() => {
                        setDraft({
                          ...draft,
                          bases: draft.bases.map((old, index) =>
                            index === runnerBase
                              ? id
                              : id != null && old === id
                                ? null
                                : old
                          )
                        })
                        setRunnerBase(null)
                      }}
                      style={[rowStyle, { opacity: disabled ? 0.45 : 1 }]}
                    >
                      <Text style={textStyle}>{label}</Text>
                    </Pressable>
                  )
                })}
              </ListCard>
            </ScoringSheet>
          )}
          {batters && (
            <ScoringSheet
              fullScreen
              title="Batter"
              onClose={() => {
                setBatters(false)
              }}
            >
              <Text
                style={{ ...textStyle, fontFamily: theme.semiBoldTextFont }}
              >
                Skip to Batter
              </Text>
              <ListCard>
                {team.battingOrder.map((id, index) => playerRow(id, index))}
              </ListCard>
              {team.battingOrder.length === 0 && (
                <Text style={textStyle}>
                  Set the batting team's lineup first.
                </Text>
              )}
              <Text
                style={{
                  ...textStyle,
                  marginTop: 16,
                  fontFamily: theme.semiBoldTextFont
                }}
              >
                Pinch Hit
              </Text>
              {draft.batter == null && (
                <Text style={textStyle}>
                  Choose a lineup batter before selecting a pinch hitter.
                </Text>
              )}
              <ListCard>
                {team.players
                  .filter(id => !team.battingOrder.includes(id))
                  .map((id, index) => playerRow(id, index, true))}
              </ListCard>
              {team.players.every(id => team.battingOrder.includes(id)) && (
                <Text style={textStyle}>No players on the bench.</Text>
              )}
            </ScoringSheet>
          )}
        </View>
      </ScopedThemeProvider>
    </ScoringSheet>
  )
}

function RunnerBases({ base }: { base: number }): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      accessibilityLabel={`On ${['first', 'second', 'third'][base]} base`}
      style={{ width: 40, height: 30 }}
    >
      {[
        { left: 27, top: 17 },
        { left: 15, top: 3 },
        { left: 3, top: 17 }
      ].map((position, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            ...position,
            width: 10,
            height: 10,
            transform: [{ rotate: '45deg' }],
            borderWidth: 1,
            borderColor: theme.primaryTextColor,
            backgroundColor:
              base === index ? theme.primaryTextColor : 'transparent'
          }}
        />
      ))}
    </View>
  )
}

function OverrideNumberPicker({
  label,
  value,
  inning,
  onClose,
  onDone
}: {
  label: string
  value: number
  inning: boolean
  onClose: () => void
  onDone: (value: number) => void
}): React.ReactElement {
  const [text, setText] = useState(String(value))
  const [jump, setJump] = useState(0)
  const [start, setStart] = useState(inning ? 1 : Math.max(0, value - 50))
  const min = inning ? 1 : 0
  const max = inning ? 50 : Number.MAX_SAFE_INTEGER
  const number = Number(text)
  const valid =
    /^\d+$/.test(text.trim()) &&
    Number.isSafeInteger(number) &&
    number >= min &&
    number <= max
  const end = Math.min(max, start + (inning ? 49 : 100))
  const options = Array.from({ length: end - start + 1 }, (_, i) => start + i)
  return (
    <PickerDialog onClose={onClose}>
      <View style={{ alignItems: 'center', gap: 12 }}>
        <Wheel
          key={`${start}:${jump}`}
          label={label}
          options={options}
          value={valid ? number : value}
          onChange={n => {
            setText(String(n))
          }}
          width={inning ? 100 : 200}
        />
        {!inning && (
          <>
            <ScoringTextInput
              accessibilityLabel="Enter score"
              keyboardType="number-pad"
              value={text}
              onChangeText={text => {
                setText(text)
                const typed = Number(text)
                if (
                  /^\d+$/.test(text.trim()) &&
                  Number.isSafeInteger(typed) &&
                  typed >= 0 &&
                  (typed < start || typed > end)
                )
                  setStart(Math.max(0, typed - 50))
              }}
            />
            <ScoringButton
              label="Go to score"
              row
              disabled={!valid}
              onPress={() => {
                setStart(Math.max(0, number - 50))
                setJump(n => n + 1)
              }}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <ScoringButton
                label="Lower scores"
                row
                disabled={start === 0}
                onPress={() => {
                  const n = Math.max(0, start - 100)
                  setStart(n)
                }}
              />
              <ScoringButton
                label="Higher scores"
                row
                disabled={end === max}
                onPress={() => {
                  setStart(end)
                }}
              />
            </View>
          </>
        )}
        <ScoringError
          message={
            valid
              ? undefined
              : inning
                ? 'Choose an inning from 1 to 50.'
                : 'Use a whole number, 0 or higher.'
          }
        />
        <ScoringButton
          label="Done"
          disabled={!valid}
          onPress={() => {
            onDone(number)
          }}
        />
        <CancelAction accessibilityLabel="Cancel" onPress={onClose} />
      </View>
    </PickerDialog>
  )
}
