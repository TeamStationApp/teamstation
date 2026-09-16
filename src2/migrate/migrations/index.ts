import type { Migration } from '../runner'
import { migration001Identity } from './001identity'
import { migration002Content } from './002content'
import { migration003Operations } from './003operations'
import { migration004Migration } from './004migration'
import { migration005SeasonsWithoutLeague } from './005seasonsWithoutLeague'
import { migration006SeasonMembers } from './006seasonMembers'

/** Every migration, in the order they were written. */
export const migrations: Migration[] = [
  migration001Identity,
  migration002Content,
  migration003Operations,
  migration004Migration,
  migration005SeasonsWithoutLeague,
  migration006SeasonMembers
]
