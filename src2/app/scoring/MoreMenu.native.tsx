import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { MoreActionEditor } from './MoreActionEditor'
import { MORE_GROUPS, moreEligibility, type MoreInput } from './moreActions'
import type { MoreMenuProps } from './moreMenuProps'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
export function MoreMenu({
  state,
  disabled,
  onActive,
  onChoose
}: MoreMenuProps): React.ReactElement {
  const theme = useTheme()
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
      <ScoringButton
        label="More"
        control
        upChevrons
        text={'⋯\nMore'}
        disabled={disabled}
        onPress={() => {
          if (disabled) return
          setOpen(true)
          onActive(true)
        }}
      />
      {open && (
        <ScoringSheet title="More" onClose={close}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ width: '50%' }}>
              {MORE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  {group.label === 'This pitch' && (
                    <Text
                      style={{
                        color: theme.primaryTextColor,
                        fontFamily: theme.semiBoldTextFont,
                        fontSize: 14.4,
                        fontWeight: '700'
                      }}
                    >
                      {group.label}
                    </Text>
                  )}
                  {group.actions
                    .filter(
                      action =>
                        ![
                          'Dropped Third Strike',
                          'Put Batter on Base'
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
                        <ScoringButton
                          row
                          menuText
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
                  width: '50%'
                }}
              >
                {['First', 'Second', 'Third'].map((label, index) => (
                  <ScoringButton
                    row
                    menuText
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
