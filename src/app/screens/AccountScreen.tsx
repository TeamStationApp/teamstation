import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Switch, Text, View } from 'react-native'

import type { AccountSettings } from '../../common/accountSettings'
import type {
  AccountApi,
  Session,
  SessionUser,
  TeamStationClient
} from '../../common/api'
import type { GameSocket } from '../../common/gameSocket'
import type { GroupRef } from '../../common/groupCreation'
import {
  type ClientPasswordCosts,
  newPasswordRequirements
} from '../../common/passwordProtocol'
import { BlockedPeople } from '../chat/BlockedPeople'
import { releaseChat } from '../chat/engine/links'
import type { ChatKeyStore } from '../chat/keyRecord'
import { keyStore } from '../chat/keyStore'
import {
  Button,
  ButtonIcon,
  Card,
  CardContent,
  DangerText,
  HeroCard,
  ListCard,
  ListRow,
  PictureSheet,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { AffiliationList } from '../components/AffiliationList'
import { NewPasswordFields } from '../components/NewPasswordFields'
import { useSceneReveals } from '../components/sceneShown'
import { SettingToggleRow } from '../components/settings/SettingToggleRow'
import { sportsPicturesEnabled } from '../components/sportsPictures'
import { useForegroundEntry } from '../hooks/useForegroundEntry'
import { lstrings } from '../locales/strings'
import {
  anySwitchOn,
  type NotificationSwitches,
  switchesKey,
  writeAsked
} from '../platform/notificationSwitches'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import {
  type PushDevice,
  pushDevice as thisDevice,
  type PushState
} from '../platform/pushDevice'
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
   * The signed-in client. Signing out leaves this account's chat keys on
   * the device and leaves the device linked.
   */
  client: TeamStationClient
  socket?: Pick<GameSocket, 'onChat'>
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
  pickPhoto?: typeof pickAccountPhoto
  /** Opens Create API key. */
  onCreateApiKey?: () => void
  onTeamStationTv?: () => void
  /** Where closing the Apple Music walkthrough is remembered. */
  readiness?: ReadinessStore
  /**
   * Another person's account, as a node administrator changes it from User
   * Management: their name and photo, read and written through `api`, and
   * their addresses to read. Nothing of the signed-in person's own is shown.
   */
  target?: { userId: string; api: AccountApi }
  /** An Affiliations row: a league, season or team, on its page. */
  onOpenGroup?: (group: GroupRef) => void
  /** An Affiliations row: a player the person guards, on their page. */
  onOpenPlayer?: (userId: string, name: string) => void
  /**
   * This device's notifications, and the switches it keeps; the platform's
   * own by default.
   */
  pushDevice?: PushDevice
}

/** What a browser's `storage` event says: the key another tab changed. */
type StorageListener = (event: { key: string | null }) => void

/** The part of the page's `window` that hears another tab's storage. */
interface StorageEvents {
  addEventListener: (type: 'storage', listener: StorageListener) => void
  removeEventListener: (type: 'storage', listener: StorageListener) => void
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
    readiness = walkUpReadiness,
    target,
    pushDevice = thisDevice
  } = props
  // Whose name and photo these are: the signed-in person's, or the person a
  // node administrator opened.
  const api: AccountApi = target?.api ?? client
  const theme = useTheme()
  const styles = getStyles(theme)
  const chatStore = props.chatStore ?? keyStore
  const [walkUp, setWalkUp] = useWalkUpPreferences()
  const [appleMusicSetup, setAppleMusicSetup] = useState(false)
  // Mounted once opened, so it can slide away; never on a visit without it.
  const [appleMusicSetupUsed, setAppleMusicSetupUsed] = useState(false)
  const [account, setAccount] = useState<AccountSettings>()
  const [blockedPeople, setBlockedPeople] = useState(false)
  const [permission, setPermission] = useState<PushState>()
  /** This device's notification switches for the signed-in person. */
  const [switches, setSwitches] = useState<NotificationSwitches>()
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [name, setName] = useState(
    target == null ? session.user.displayName : ''
  )
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
  // Another person's account shows nothing until it is theirs.
  const user = account?.user ?? (target == null ? session.user : undefined)

  // What another screen changed about this account, as Node Administration
  // can. A name being typed here is left alone.
  const reveals = useSceneReveals()
  useEffect(() => {
    let live = true
    setLoadError('')
    api
      .accountSettings()
      .then(value => {
        if (!live) return
        setAccount(value)
        if (reveals === 0) setName(value.user.displayName)
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
  }, [api, reload, reveals])

  // The switches are this device's own for the signed-in person, so another
  // person's account, as an administrator opens it, has none here, and its
  // permission is not read.
  const own = target == null
  const me = session.user.id
  // Read again whenever the app comes back to the foreground, and not on a
  // timer: the permission may have been changed in the phone's or the
  // browser's settings meanwhile, and the switches in another tab.
  const permissionRead = useRef(0)
  useEffect(
    () => () => {
      permissionRead.current++
    },
    [pushDevice]
  )
  const readPermission = useCallback(async (): Promise<void> => {
    if (!own) return
    const version = ++permissionRead.current
    const value = await pushDevice.state()
    if (version === permissionRead.current) setPermission(value)
  }, [own, pushDevice])
  useForegroundEntry(readPermission)
  /** The switches as last shown, which the next change starts from. */
  const switchesNow = useRef<NotificationSwitches | undefined>(undefined)
  /**
   * Counts reads and changes of the switches, so an answer is shown only
   * while nothing has begun since it was asked for.
   */
  const switchesTurn = useRef(0)
  useEffect(
    () => () => {
      switchesTurn.current++
    },
    [me, own, pushDevice]
  )
  const show = (value: NotificationSwitches | undefined): void => {
    switchesNow.current = value
    setSwitches(value)
  }
  const readStoredSwitches = useCallback(async (): Promise<void> => {
    if (!own) return
    const turn = ++switchesTurn.current
    const read = await pushDevice.switches(me)
    if (turn !== switchesTurn.current) return
    switchesNow.current = read
    setSwitches(read)
  }, [me, own, pushDevice])
  useEffect(() => {
    switchesNow.current = undefined
    setSwitches(undefined)
  }, [me, own, pushDevice])
  useForegroundEntry(readStoredSwitches)
  // Another tab of this browser changed them (or cleared its storage).
  useEffect(() => {
    const page = (globalThis as { window?: StorageEvents }).window
    if (!own || Platform.OS !== 'web' || page == null) return
    const key = switchesKey(me)
    const changed: StorageListener = event => {
      if (event.key === key || event.key == null)
        readStoredSwitches().catch(() => undefined)
    }
    page.addEventListener('storage', changed)
    return () => {
      page.removeEventListener('storage', changed)
    }
  }, [me, own, readStoredSwitches])

  const accept = (value: AccountSettings): void => {
    setAccount(value)
    // The signed-in person's own, whichever page changed it.
    if (target == null || target.userId === session.user.id)
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
   * Any change the person makes here is their answer: the app's own ask
   * (`startAsk`) never comes to them on this device after it, and never
   * changes their switches itself, but for a League management ask, which
   * turns on League management alone.
   */
  const decided = (): void => {
    writeAsked(me).catch(() => undefined)
  }
  /**
   * Asks this device for permission, while the tap still counts as the
   * person's; allowed, it registers with the switches it keeps then. The
   * answer can wait on the person, so nothing waits on it.
   */
  const ask = (): void => {
    pushDevice.enable(client, me).then(
      value => {
        // A read begun before the answer would show what it replaced.
        permissionRead.current++
        setPermission(value)
      },
      () => undefined
    )
  }
  /**
   * Keeps a switch on this device, which tells the server by its
   * registration (`setSwitches`). Turning one on asks this device for
   * permission when it has not been asked.
   */
  const notify = (change: Partial<NotificationSwitches>, on: boolean): void => {
    const current = switchesNow.current
    if (current == null) return
    const turn = ++switchesTurn.current
    decided()
    show({ ...current, ...change })
    pushDevice.setSwitches(client, me, change).then(
      stored => {
        if (turn === switchesTurn.current) show(stored)
      },
      () => undefined
    )
    if (on) ask()
  }
  const wanted = switches != null && anySwitchOn(switches)

  /**
   * The session ends. This account's chat keys stay, and the device stays
   * linked, so the same account opens chat on this device next time.
   */
  const signOut = (): void => {
    if (onSignOutRequest != null) {
      onSignOutRequest()
      return
    }
    setSigningOut(true)
    releaseChat(chatStore)
      .finally(onSignOut)
      .catch(() => undefined)
  }

  if (user == null)
    return (
      <Screen>
        <Card style={styles.setting}>
          <Text
            accessibilityRole={loadError === '' ? undefined : 'alert'}
            style={styles.email}
          >
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
      </Screen>
    )

  return (
    <Screen>
      {target != null && (
        <Text accessibilityRole="header" style={styles.targetTitle}>
          {`Account · ${user.displayName}`}
        </Text>
      )}
      <HeroCard
        // The account's id, so its tile is the colour its rows are.
        person={{ userId: user.id }}
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
          person={{ userId: user.id }}
          allowCatalog={sportsPicturesEnabled}
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
                accept(await api.setAccountPhoto(choice.image))
              else if (choice.catalogId != null) {
                await api.chooseCatalogPicture(choice.catalogId)
                accept(await api.accountSettings())
              } else accept(await api.clearAccountPhoto())
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
                    const value = await api.setAccountName(name)
                    accept(value)
                    setName(value.user.displayName)
                    setNotice({ section: 'profile', message: 'Name saved' })
                  })
                }}
              />
              {feedback('profile')}
            </Card>
          </View>
          {target != null ? (
            <View style={styles.section}>
              <SectionHeader title="Email addresses" />
              <ListCard>
                {account.emails.map(address => (
                  <CardContent key={address.id} style={styles.setting}>
                    <Text style={styles.settingLabel}>
                      {address.email}
                      {address.isPrimary ? ' · Primary' : ''}
                      {address.isVerified === false ? ' · Unverified' : ''}
                    </Text>
                  </CardContent>
                ))}
              </ListCard>
            </View>
          ) : (
            <>
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
                        <Text
                          accessibilityLiveRegion="polite"
                          style={styles.email}
                        >
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
                                  throw new Error(
                                    'The new passwords do not match'
                                  )
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
                                  await client.setAccountPrimaryEmail(
                                    address.id
                                  )
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
                            Replacing {emailEdit.previous}. It stays active
                            until you confirm the new address.
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
                          Enter the code sent to {pending.email}. The address is
                          not active yet.
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
              <AffiliationList
                client={client}
                onOpenGroup={props.onOpenGroup}
                onOpenPlayer={props.onOpenPlayer}
              />
            </>
          )}
        </>
      )}
      {busy !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.email}>
          Saving…
        </Text>
      )}

      {target == null && (
        <>
          {props.onTeamStationTv != null && (
            <ListCard>
              <ListRow
                title="TeamStation TV"
                emblemIcon="smart_display"
                onPress={props.onTeamStationTv}
              />
            </ListCard>
          )}
          <View style={styles.section}>
            <SectionHeader title={lstrings.account_chat} />
            <ListCard>
              {onChatDevices != null && (
                <ListRow
                  title={lstrings.account_chat_devices}
                  subtitle={lstrings.account_chat_devices_detail}
                  emblemIcon="settings"
                  onPress={onChatDevices}
                />
              )}
              <ListRow
                title={lstrings.chat_blocked_people}
                subtitle={lstrings.chat_blocked_people_detail}
                emblemIcon="settings"
                onPress={() => {
                  setBlockedPeople(true)
                }}
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
          {switches != null && (
            <View style={styles.section}>
              <SectionHeader title={lstrings.account_notifications} />
              <ListCard>
                <SettingToggleRow
                  label={lstrings.account_notifications_messages}
                  value={switches.messages}
                  onChange={messages => {
                    notify({ messages }, messages)
                  }}
                />
                <SettingToggleRow
                  label={lstrings.account_notifications_rsvp_events}
                  value={switches.rsvpEvents}
                  onChange={rsvpEvents => {
                    notify({ rsvpEvents }, rsvpEvents)
                  }}
                />
                <SettingToggleRow
                  label={lstrings.account_notifications_league_management}
                  value={switches.leagueManagement}
                  onChange={leagueManagement => {
                    notify({ leagueManagement }, leagueManagement)
                  }}
                />
              </ListCard>
              {wanted && permission === 'denied' && (
                <Text accessibilityLiveRegion="polite" style={styles.email}>
                  {lstrings.account_notifications_blocked}
                </Text>
              )}
              {/* A phone asks by itself (App's askWhenWanted); a browser asks
                  only from a tap. */}
              {wanted && permission === 'prompt' && Platform.OS === 'web' && (
                <Button
                  label={lstrings.account_notifications_allow}
                  kind="secondary"
                  style={{ alignSelf: 'flex-start' }}
                  onPress={() => {
                    decided()
                    ask()
                  }}
                />
              )}
            </View>
          )}
          {blockedPeople && (
            <BlockedPeople
              key={session.user.id}
              client={client}
              socket={props.socket}
              onClose={() => {
                setBlockedPeople(false)
              }}
            />
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
                  <ButtonIcon
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
              userId={session.user.id}
              store={chatStore}
              onCancel={() => {
                setDeleteOpen(false)
              }}
              onLeave={() => {
                setDeleteOpen(false)
                onAccountDeleted()
              }}
            />
          )}
        </>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  targetTitle: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont
  },
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
