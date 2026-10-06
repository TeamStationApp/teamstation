import { argon2id } from '@sonnetstationsolutions/expo-argon2'

import type { PasswordKdf } from '../../common/passwordProtocol'
import { nativePasswordKdf } from './passwordKdfNative'

export const passwordKdf: PasswordKdf = async (password, parameters) =>
  await nativePasswordKdf(password, parameters, argon2id)
