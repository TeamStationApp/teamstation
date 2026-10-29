import React, { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Switch, Text, View } from 'react-native'

import type { AccountSettings } from '../../common/accountSettings'
import type { Session, SessionUser, TeamStationClient } from '../../common/api'
import {
  type ClientPasswordCosts,
  newPasswordRequirements
} from '../../common/passwordProtocol'
import { leaveChat } from '../chat/engine/links'
import type { ChatKeyStore } from '../chat/keyRecord'
import { keyStore } from '../chat/keyStore'
import {
  Button,
  Card,
  CardContent,
  DangerText,
  HeroCard,
  Icon,
  ListCard,
  ListRow,
  PictureSheet,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { NewPasswordFields } from '../components/NewPasswordFields'
import { lstrings } from '../locales/strings'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AppleMusicSetup } from '../walkup/AppleMusicSetup'
import { useWalkUpPreferences } from '../walkup/walkUpPreferences'
import {
  markOnboarded,
  type ReadinessStore,
  walkUpReadiness
} from '../walkup/walkUpReadiness'
import { ApiKeysSection } from './ApiKeysSection'
import { DeleteAccountSheet } from './DeleteAccountSheet'

export interface AccountScreenProps {
  session: Session
  /**
   * The signed-in client. Signing out first removes this device from chat
   * and wipes its chat keys.
   */
  client: TeamStationClient
  onAccountChanged?: (user: SessionUser) => void
  /** This device's chat key store; the platform's own by default. */
  chatStore?: ChatKeyStore
  /** Opens Chat devices. */
  onChatDevices?: () => void
  /** Opens the reported chat messages; shown to site administrators only. */
  onChatReports?: () => void
  onSignOut: () => void
  /** The shell may ask about unsent offline work before ending the session. */
  onSignOutRequest?: () => void
  /** The account was deleted, or its session ended mid-delete; leave without asking the server. */
  onAccountDeleted?: () => void
  onNodeAdministration?: () => void
  pickPhoto?: typeof pickAccountPhoto
  /** Opens Create API key. */
  onCreateApiKey?: () => void
  /** Where closing the Apple Music walkthrough is remembered. */
  readiness?: ReadinessStore
}

/** A person's identity and verified sign-in methods, all on their own account. */
export function AccountScreen(props: AccountScreenProps): React.ReactElement {
  const {
    session,
    client,
    onChatDevices,
    onChatReports,
    onCreateApiKey,
    onSignOut,
    onSignOutRequest,
    onAccountDeleted = onSignOut,
    onAccountChanged,
    pickPhoto = pickAccountPhoto,
    onNodeAdministration,
    readiness = walkUpReadiness
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const chatStore = props.chatStore ?? keyStore
  const [walkUp, setWalkUp] = useWalkUpPreferences()
  const [appleMusicSetup, setAppleMusicSetup] = useState(false)
  // Mounted once opened, so it can slide away; never on a visit without it.
  const [appleMusicSetupUsed, setAppleMusicSetupUsed] = useState(false)
  const [account, setAccount] = useState<AccountSettings>()
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [name, setName] = useState(session.user.displayName)
  const [busy, setBusy] = useState('')
  const working = useRef(false)
  const [notice, setNotice] = useState<{ section: string; message: string }>()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [photoOpen, setPhotoOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const preparation = useRef<Promise<ClientPasswordCosts> | undefined>(
    undefined
  )
  const [preparing, setPreparing] = useState(false)
  const [preparationError, setPreparationError] = useState('')
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const passwordLifetime = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    let live = true
    const lifetime = new AbortController()
    passwordLifetime.current = lifetime
    setPreparationError('')
    setPreparing(passwordOpen)
    preparation.current = undefined
    if (passwordOpen) {
      const pending = client.preparePasswordCosts()
      preparation.current = pending
      pending.then(
        () => {
          if (live) setPreparing(false)
        },
        (error: unknown) => {
          if (!live) return
          setPreparing(false)
          setPreparationError(
            error instanceof Error
              ? error.message
              : 'Could not prepare your password. Please retry'
          )
        }
      )
    }
    return () => {
      live = false
      lifetime.abort()
    }
  }, [client, passwordOpen, preparationAttempt])
  const [reset, setReset] = useState<{ requestId: string; email: string }>()
  const [resetCode, setResetCode] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [emailEdit, setEmailEdit] = useState<{
    replaceEmailId?: string
    previous?: string
  }>()
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<{
    requestId: string
    email: string
    replaceEmailId?: string
  }>()
  const [code, setCode] = useState('')
  const user = account?.user ?? session.user

  useEffect(() => {
    let live = true
    setLoadError('')
    client
      .accountSettings()
      .then(value => {
        if (!live) return
        setAccount(value)
        setName(value.user.displayName)
      })
      .catch((error: unknown) => {
        if (live)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Could not load account settings'
          )
      })
    return () => {
      live = false
    }
  }, [client, reload])

  const accept = (value: AccountSettings): void => {
    setAccount(value)
    onAccountChanged?.(value.user)
  }
  const run = (
    section: string,
    operation: () => Promise<void>,
    busyAction = section
  ): void => {
    if (working.current) return
    working.current = true
    setBusy(busyAction)
    setNotice(undefined)
    operation()
      .catch((error: unknown) => {
        setNotice({
          section,
          message:
            error instanceof Error
              ? error.message
              : 'Something went wrong. Please try again'
        })
      })
      .finally(() => {
        working.current = false
        setBusy('')
      })
  }
  const feedback = (section: string): React.ReactNode =>
    notice?.section === section ? (
      <Text accessibilityLiveRegion="polite" style={styles.feedback}>
        {notice.message}
      </Text>
    ) : null
  const closeEmail = (): void => {
    setEmailEdit(undefined)
    setPending(undefined)
    setEmail('')
    setCode('')
  }
  const sendCode = (): void => {
    const address = pending?.email ?? email.trim().toLowerCase()
    const replacing = pending?.replaceEmailId ?? emailEdit?.replaceEmailId
    run('email', async () => {
      const requested = await client.requestAccountEmail(address, replacing)
      setPending({ ...requested, email: address, replaceEmailId: replacing })
      setCode('')
      setNotice({ section: 'email', message: `A code was sent to ${address}` })
    })
  }
  const [signingOut, setSigningOut] = useState(false)

  /**
   * This device leaves chat before the session ends: the server revokes it
   * (which ends the session too) and its keys are wiped, so whoever signs in
   * on it next reads nothing of this person's chats.
   */
  const signOut = (): void => {
    if (onSignOutRequest != null) {
      onSignOutRequest()
      return
    }
    setSigningOut(true)
    leaveChat({ client, store: chatStore })
      .finally(onSignOut)
      .catch(() => undefined)
  }

  return (
    <Screen>
      <HeroCard
        person
        name={user.displayName}
        secondary={user.email}
        uri={user.avatarUrl}
        disabled={account == null || busy !== ''}
        onEdit={() => {
          setPhotoOpen(true)
        }}
      />
      {feedback('photo')}
      {photoOpen && (
        <PictureSheet
          client={client}
          name={user.displayName}
          allowCatalog
          pickPhoto={pickPhoto}
          onClose={() => {
            setPhotoOpen(false)
          }}
          onSave={async choice => {
            if (working.current)
              throw new Error('Another change is being saved')
            working.current = true
            setBusy('photo')
            setNotice(undefined)
            try {
              if (choice.image != null)
                accept(await client.setAccountPhoto(choice.image))
              else if (choice.catalogId != null) {
                await client.chooseCatalogPicture(choice.catalogId)
                accept(await client.accountSettings())
              } else accept(await client.clearAccountPhoto())
              setNotice({ section: 'photo', message: 'Photo saved' })
            } finally {
              working.current = false
              setBusy('')
            }
          }}
        />
      )}
      {account == null ? (
        <Card style={styles.setting}>
          <Text style={styles.email}>
            {loadError !== '' ? loadError : 'Loading account settings…'}
          </Text>
          {loadError !== '' && (
            <Button
              label="Retry"
              onPress={() => {
                setReload(value => value + 1)
              }}
            />
          )}
        </Card>
      ) : (
        <>
          <View style={styles.section}>
            <SectionHeader title="Name" />
            <Card style={styles.setting}>
              <TextField label="Name" value={name} onChangeText={setName} />
              <Button
                label="Save name"
                style={{ alignSelf: 'flex-start' }}
                disabled={
                  busy !== '' ||
                  name.trim() === '' ||
                  name.trim() === user.displayName
                }
                onPress={() => {
                  run('profile', async () => {
                    const value = await client.setAccountName(name)
                    accept(value)
                    setName(value.user.displayName)
                    setNotice({ section: 'profile', message: 'Name saved' })
                  })
                }}
              />
              {feedback('profile')}
            </Card>
          </View>
          <View style={styles.section}>
            <SectionHeader title="Password" />
            <Card style={styles.setting}>
              <Text style={styles.email}>
                You can always sign in with an email code.
              </Text>
              {!passwordOpen ? (
                <Button
                  label={
                    account.passwordNeedsUpgrade
                      ? 'Verify email and set password'
                      : account.hasPassword
                        ? 'Change password'
                        : 'Set password'
                  }
                  kind="secondary"
                  disabled={busy !== ''}
                  onPress={() => {
                    if (account.passwordNeedsUpgrade) {
                      run('password', async () => {
                        setReset(await client.requestPasswordReset())
                        setResetCode('')
                        setPasswordOpen(true)
                      })
                    } else {
                      setPasswordOpen(true)
                      setNotice(undefined)
                    }
                  }}
                />
              ) : (
                <>
                  {reset != null ? (
                    <>
                      <Text style={styles.email}>
                        Enter the code sent to {reset.email} to set a new
                        password.
                      </Text>
                      <TextField
                        label="Password reset code"
                        value={resetCode}
                        onChangeText={setResetCode}
                        keyboardType="number-pad"
                        autoComplete="one-time-code"
                      />
                      <Button
                        label="Resend password code"
                        kind="text"
                        disabled={busy !== ''}
                        onPress={() => {
                          run('password', async () => {
                            setReset(await client.requestPasswordReset())
                            setResetCode('')
                          })
                        }}
                      />
                    </>
                  ) : (
                    account.hasPassword && (
                      <TextField
                        label="Current password"
                        value={currentPassword}
                        onChangeText={setCurrentPassword}
                        secure
                        autoComplete="current-password"
                      />
                    )
                  )}
                  {reset == null && account.hasPassword && (
                    <Button
                      label="Reset with an email code"
                      kind="text"
                      disabled={busy !== ''}
                      onPress={() => {
                        run('password', async () => {
                          setReset(await client.requestPasswordReset())
                          setResetCode('')
                          setCurrentPassword('')
                        })
                      }}
                    />
                  )}
                  <NewPasswordFields
                    password={password}
                    confirmation={confirmation}
                    onPassword={setPassword}
                    onConfirmation={setConfirmation}
                  />
                  {preparing && (
                    <Text accessibilityLiveRegion="polite" style={styles.email}>
                      Preparing password security… You can keep typing.
                    </Text>
                  )}
                  {preparationError !== '' && (
                    <>
                      <Text
                        accessibilityLiveRegion="polite"
                        style={styles.feedback}
                      >
                        {preparationError}
                      </Text>
                      <Button
                        label="Retry password preparation"
                        kind="text"
                        disabled={busy !== ''}
                        onPress={() => {
                          setPreparationAttempt(value => value + 1)
                        }}
                      />
                    </>
                  )}
                  <View style={styles.actions}>
                    <Button
                      label="Save password"
                      busy={busy === 'savePassword'}
                      busyLabel="Saving password"
                      disabled={
                        busy !== '' ||
                        !newPasswordRequirements(password).valid ||
                        password !== confirmation ||
                        preparationError !== '' ||
                        (reset != null && resetCode.trim() === '')
                      }
                      onPress={() => {
                        run(
                          'password',
                          async () => {
                            if (password !== confirmation)
                              throw new Error('The new passwords do not match')
                            const signal = passwordLifetime.current?.signal
                            const value = await client.setAccountPassword(
                              password,
                              currentPassword,
                              reset == null
                                ? undefined
                                : {
                                    requestId: reset.requestId,
                                    code: resetCode
                                  },
                              preparation.current,
                              signal
                            )
                            if (signal?.aborted === true) return
                            accept(value)
                            setReset(undefined)
                            setResetCode('')
                            setCurrentPassword('')
                            setPassword('')
                            setConfirmation('')
                            setPasswordOpen(false)
                            setNotice({
                              section: 'password',
                              message: 'Password saved'
                            })
                          },
                          'savePassword'
                        )
                      }}
                    />
                    <Button
                      label="Cancel password change"
                      kind="text"
                      disabled={busy !== ''}
                      onPress={() => {
                        setReset(undefined)
                        setResetCode('')
                        setCurrentPassword('')
                        setPassword('')
                        setConfirmation('')
                        setPasswordOpen(false)
                        setNotice(undefined)
                      }}
                    />
                  </View>
                </>
              )}
              {feedback('password')}
            </Card>
          </View>
          <View style={styles.section}>
            <SectionHeader title="Email addresses" />
            <ListCard>
              <CardContent>
                <Text style={styles.email}>
                  Sign in with any confirmed address. Your primary address
                  appears on your account.
                </Text>
              </CardContent>
              {account.emails.map(address => (
                <CardContent key={address.id} style={styles.setting}>
                  <Text style={styles.settingLabel}>
                    {address.email}
                    {address.isPrimary ? ' · Primary' : ''}
                  </Text>
                  <View style={styles.actions}>
                    <Button
                      label="Change"
                      accessibilityLabel={`Change ${address.email}`}
                      kind="text"
                      disabled={busy !== '' || emailEdit != null}
                      onPress={() => {
                        setEmailEdit({
                          replaceEmailId: address.id,
                          previous: address.email
                        })
                        setEmail('')
                        setNotice(undefined)
                      }}
                    />
                    {!address.isPrimary && (
                      <Button
                        label="Make primary"
                        accessibilityLabel={`Make ${address.email} primary`}
                        kind="text"
                        disabled={busy !== '' || emailEdit != null}
                        onPress={() => {
                          run('email', async () => {
                            accept(
                              await client.setAccountPrimaryEmail(address.id)
                            )
                            setNotice({
                              section: 'email',
                              message: 'Primary email updated'
                            })
                          })
                        }}
                      />
                    )}
                  </View>
                </CardContent>
              ))}
              <CardContent style={styles.setting}>
                {emailEdit == null ? (
                  <Button
                    label="Add email address"
                    kind="secondary"
                    disabled={busy !== ''}
                    onPress={() => {
                      setEmailEdit({})
                      setNotice(undefined)
                    }}
                  />
                ) : pending == null ? (
                  <>
                    {emailEdit.previous != null && (
                      <Text style={styles.email}>
                        Replacing {emailEdit.previous}. It stays active until
                        you confirm the new address.
                      </Text>
                    )}
                    <TextField
                      label="New email address"
                      value={email}
                      onChangeText={setEmail}
                      keyboardType="email-address"
                      autoComplete="email"
                    />
                    <Button
                      label="Send confirmation code"
                      disabled={busy !== '' || email.trim() === ''}
                      onPress={sendCode}
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.email}>
                      Enter the code sent to {pending.email}. The address is not
                      active yet.
                    </Text>
                    <TextField
                      label="Confirmation code"
                      value={code}
                      onChangeText={setCode}
                      keyboardType="number-pad"
                      autoComplete="one-time-code"
                    />
                    <View style={styles.actions}>
                      <Button
                        label="Confirm email"
                        disabled={busy !== '' || code.trim() === ''}
                        onPress={() => {
                          run('email', async () => {
                            accept(
                              await client.confirmAccountEmail(
                                pending.requestId,
                                code
                              )
                            )
                            closeEmail()
                            setNotice({
                              section: 'email',
                              message: 'Email address confirmed'
                            })
                          })
                        }}
                      />
                      <Button
                        label="Resend code"
                        kind="text"
                        disabled={busy !== ''}
                        onPress={sendCode}
                      />
                    </View>
                  </>
                )}
                {emailEdit != null && (
                  <Button
                    label="Cancel email change"
                    kind="text"
                    disabled={busy !== ''}
                    onPress={() => {
                      closeEmail()
                      setNotice(undefined)
                    }}
                  />
                )}
                {feedback('email')}
              </CardContent>
            </ListCard>
          </View>
        </>
      )}
      {busy !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.email}>
          Saving…
        </Text>
      )}

      {onChatDevices != null && (
        <View style={styles.section}>
          <SectionHeader title={lstrings.account_chat} />
          <ListCard>
            <ListRow
              title={lstrings.account_chat_devices}
              subtitle={lstrings.account_chat_devices_detail}
              emblemIcon="settings"
              onPress={onChatDevices}
            />
            {onChatReports != null && user.isAdmin && (
              <>
                <ListRow
                  title={lstrings.chat_reports_title}
                  subtitle={lstrings.account_chat_reports_detail}
                  emblemIcon="star"
                  onPress={onChatReports}
                />
              </>
            )}
          </ListCard>
        </View>
      )}
      {Platform.OS === 'ios' && (
        <View style={styles.section}>
          <SectionHeader title={lstrings.account_walkup} />
          <ListCard>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.account_walkup_apple_music}
              onPress={() => {
                setAppleMusicSetupUsed(true)
                setAppleMusicSetup(true)
              }}
              style={[styles.settingRow, styles.paddedRow]}
            >
              <Text style={styles.settingLabel}>
                {lstrings.account_walkup_apple_music}
              </Text>
              <Icon
                name="chevron_right"
                size={1.25}
                color={theme.secondaryTextColor}
              />
            </Pressable>
            <CardContent style={styles.setting}>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>
                  {lstrings.account_walkup_fade}
                </Text>
                <Switch
                  accessibilityLabel={lstrings.account_walkup_fade}
                  value={walkUp.fadeAppleMusic}
                  onValueChange={fadeAppleMusic => {
                    setWalkUp({ ...walkUp, fadeAppleMusic })
                  }}
                />
              </View>
              <Text style={styles.email}>
                {lstrings.account_walkup_fade_detail}
              </Text>
            </CardContent>
          </ListCard>
          {appleMusicSetupUsed && (
            <AppleMusicSetup
              visible={appleMusicSetup}
              onClose={() => {
                setAppleMusicSetup(false)
                markOnboarded(readiness).catch(() => undefined)
              }}
            />
          )}
        </View>
      )}
      <ApiKeysSection client={client} onCreate={onCreateApiKey} />
      <DangerText
        label={lstrings.account_sign_out}
        bold
        disabled={busy !== '' || signingOut}
        style={styles.centered}
        onPress={signOut}
      />
      {user.isAdmin && onNodeAdministration != null && (
        <Button
          label="Node administration"
          kind="secondary"
          block
          onPress={onNodeAdministration}
        />
      )}
      <DangerText
        label={lstrings.account_delete}
        bold
        disabled={busy !== ''}
        style={styles.centered}
        onPress={() => {
          setDeleteOpen(true)
        }}
      />
      {deleteOpen && (
        <DeleteAccountSheet
          client={client}
          onCancel={() => {
            setDeleteOpen(false)
          }}
          onLeave={() => {
            setDeleteOpen(false)
            onAccountDeleted()
          }}
        />
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  feedback: {
    fontFamily: theme.regularTextFont,
    color: theme.primaryTextColor,
    fontSize: theme.rem(0.875)
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  avatar: {
    width: theme.rem(3.5),
    height: theme.rem(3.5),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.scoreboardBackground,
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.scoreboardAccentColor
  },
  identityText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  name: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.375),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  email: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  setting: {
    gap: theme.rem(theme.spaceSmRem)
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  settingLabel: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  paddedRow: {
    padding: theme.rem(theme.cardContentInsetRem)
  },
  centered: {
    alignSelf: 'center'
  },
  footnote: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  }
}))
