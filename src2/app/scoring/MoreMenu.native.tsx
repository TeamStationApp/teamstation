import React, { useState } from 'react'
import { Text } from 'react-native'

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
  const [form, setForm] = useState<MoreInput>()
  const close = (): void => {
    setOpen(false)
    setBase(false)
    setForm(undefined)
    onActive(false)
  }
  const choose = (input: MoreInput): void => {
    if (
      input.action === 'Put Batter on Base' ||
      input.action === 'Place a Runner (Tiebreaker)'
    ) {
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
        text={'⋯\nMore'}
        disabled={disabled}
        onPress={() => {
          setOpen(true)
          onActive(true)
        }}
      />
      {open && (
        <ScoringSheet title="More" onClose={close}>
          {base
            ? ['First', 'Second', 'Third'].map((label, index) => (
                <ScoringButton
                  row
                  key={label}
                  label={label}
                  onPress={() => {
                    choose({ action: 'Put Batter on Base', base: index + 1 })
                  }}
                />
              ))
            : MORE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  <Text
                    style={{
                      color: theme.primaryTextColor,
                      fontFamily: theme.semiBoldTextFont
                    }}
                  >
                    {group.label}
                  </Text>
                  {group.actions
                    .filter(
                      action =>
                        action !== 'Strike Three, Not Caught' ||
                        moreEligibility(state, action) == null
                    )
                    .map(action => (
                      <ScoringButton
                        row
                        key={action}
                        label={action}
                        submenu={action === 'Put Batter on Base'}
                        disabled={moreEligibility(state, action) != null}
                        onPress={() => {
                          if (action === 'Put Batter on Base') setBase(true)
                          else choose({ action })
                        }}
                      />
                    ))}
                </React.Fragment>
              ))}
        </ScoringSheet>
      )}
      {form != null && (
        <MoreActionEditor
          state={state}
          input={form}
          onCancel={close}
          onSave={input => {
            close()
            onChoose(input)
          }}
        />
      )}
    </>
  )
}
