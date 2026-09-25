import React, { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { MoreActionEditor } from './MoreActionEditor'
import { MORE_GROUPS, moreEligibility, type MoreInput } from './moreActions'
import type { MoreMenuProps } from './moreMenuProps'
import {
  CONTROL_COLORS,
  ControlBackdrop,
  ControlFace,
  controlFrame
} from './ScoringControlAppearance'
import { SCORING_MENU, ScoringMenuButton } from './ScoringMenuAppearance'
import { ScoringSheet } from './ScoringSheet'
export function MoreMenu({
  state,
  disabled,
  onActive,
  onChoose
}: MoreMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(false)
  const [baseY, setBaseY] = useState(0)
  const [form, setForm] = useState<MoreInput>()
  const close = (): void => {
    setOpen(false)
    setBase(false)
    setForm(undefined)
    onActive(false)
  }
  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setBase(false)
      setForm(undefined)
      onActive(false)
    }
  }, [disabled, onActive])
  const choose = (input: MoreInput): void => {
    if (disabled || moreEligibility(state, input.action) != null) return
    if (input.action === 'Place a Runner (Tiebreaker)') {
      setOpen(false)
      setForm(input)
    } else {
      close()
      onChoose(input)
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More"
        disabled={disabled}
        style={{
          ...controlFrame,
          flex: 1,
          borderColor: CONTROL_COLORS.more.border,
          backgroundColor: CONTROL_COLORS.more.bottom,
          opacity: disabled ? 0.5 : 1
        }}
        onPress={() => {
          if (disabled) return
          setOpen(true)
          onActive(true)
        }}
      >
        <ControlBackdrop kind="more" />
        <ControlFace kind="more" />
      </Pressable>
      {open && (
        <ScoringSheet title="More" onClose={close}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View
              style={{
                width: '50%',
                backgroundColor: SCORING_MENU.background,
                borderColor: SCORING_MENU.border,
                borderWidth: 1,
                borderRadius: 12,
                overflow: 'hidden'
              }}
            >
              {MORE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  {group.actions
                    .filter(
                      action =>
                        ![
                          'Dropped Third Strike',
                          'Put Batter on Base',
                          'Balk'
                        ].includes(action) ||
                        moreEligibility(state, action) == null
                    )
                    .map(action => (
                      <View
                        key={action}
                        onLayout={event => {
                          if (action === 'Put Batter on Base')
                            setBaseY(event.nativeEvent.layout.y)
                        }}
                      >
                        <ScoringMenuButton
                          label={action}
                          submenuRight={action === 'Put Batter on Base'}
                          disabled={moreEligibility(state, action) != null}
                          onPress={() => {
                            if (action === 'Put Batter on Base') setBase(!base)
                            else choose({ action })
                          }}
                        />
                      </View>
                    ))}
                </React.Fragment>
              ))}
            </View>
            {base && (
              <View
                accessibilityLabel="Batter base"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: baseY,
                  width: '50%',
                  backgroundColor: SCORING_MENU.background,
                  borderColor: SCORING_MENU.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  overflow: 'hidden'
                }}
              >
                {['First', 'Second', 'Third'].map((label, index) => (
                  <ScoringMenuButton
                    key={label}
                    label={label}
                    onPress={() => {
                      choose({ action: 'Put Batter on Base', base: index + 1 })
                    }}
                  />
                ))}
              </View>
            )}
          </View>
        </ScoringSheet>
      )}
      {form != null && (
        <MoreActionEditor
          state={state}
          input={form}
          onCancel={close}
          onSave={input => {
            if (disabled) return
            close()
            onChoose(input)
          }}
        />
      )}
    </>
  )
}
