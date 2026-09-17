import type { Migration } from '../runner'
import { migration001Identity } from './001identity'
import { migration002Content } from './002content'
import { migration003Operations } from './003operations'
import { migration004Migration } from './004migration'
import { migration005SeasonsWithoutLeague } from './005seasonsWithoutLeague'
import { migration006SeasonMembers } from './006seasonMembers'
import { migration007RateLimits } from './007rateLimits'
import { migration008MergedTeams } from './008mergedTeams'
import { migration009Images } from './009images'
import { migration010Credits } from './010credits'

/** Every migration, in the order they were written. */
export const migrations: Migration[] = [
  migration001Identity,
  migration002Content,
  migration003Operations,
  migration004Migration,
  migration005SeasonsWithoutLeague,
  migration006SeasonMembers,
  migration007RateLimits,
  migration008MergedTeams,
  migration009Images,
  migration010Credits
]
