import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  POSITION_CODES,
  STORED_EVENT_TYPES
} from '../common/gumbo/reference'
import { JERSEY_MAX_LENGTH, PLAYER_POSITIONS } from '../common/playerSettings'
import {
  CLIP_MAX_MS,
  CLIP_MIN_MS,
  WALK_UP_PROVIDERS
} from '../common/walkUpSong'

/**
 * The API's own description, served at `/api/v1/openapi.json`.
 *
 * It is written by hand rather than generated, because the cleaners describe
 * what the code accepts and this describes what the API promises; keeping them
 * apart means a careless change to a cleaner cannot silently rewrite the
 * contract. The route tests check the two agree.
 */
export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string }>
  components: Record<string, unknown>
  paths: Record<string, unknown>
}

const teamIdParam = {
  name: 'teamId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const gameIdParam = {
  name: 'gameId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const streamIdParam = {
  name: 'streamId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const videoIdParam = {
  name: 'videoId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const userIdParam = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const errorResponse = {
  description: 'The one error shape used by every failure',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiError' }
    }
  }
}

/** The three path pieces the manage page's endpoints share. */
const scopeTypeParam = {
  name: 'scopeType',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['league', 'season', 'team'] }
}
const scopeIdParam = {
  name: 'scopeId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}
/** Feet to the fence a level sets, or null to leave it to the one above. */
const fenceDistanceFt = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: 600
}
const fenceDistanceBody = {
  type: 'object',
  required: ['fenceDistanceFt'],
  properties: { fenceDistanceFt }
}

/** Anything with an id and a name, which is how the tree is drawn. */
const namedThing = {
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } }
}

/** An id another system has for a person, by the rules `POST /teams` uses. */
const memberExternalId = {
  type: 'object',
  required: ['system', 'kind', 'id'],
  properties: {
    system: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]{0,31}$' },
    kind: { type: 'string', minLength: 1 },
    id: { type: 'string', minLength: 1 }
  }
}

/** A person's two names, trimmed; either may be empty. */
const personNames = {
  firstName: { type: 'string', maxLength: 100 },
  lastName: { type: 'string', maxLength: 100 }
}

/** Why one row of a roster call was refused while the others applied. */
const memberRowError = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', enum: ['conflict'] },
    message: { type: 'string' }
  }
}

/** The body both picture routes take. */
const pictureBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['image', 'source'],
        properties: {
          image: {
            type: 'object',
            required: ['contentType', 'base64'],
            properties: {
              contentType: {
                type: 'string',
                enum: ['image/jpeg', 'image/png', 'image/webp']
              },
              base64: {
                type: 'string',
                pattern: '^[A-Za-z0-9+/]+={0,2}$',
                description:
                  'The bytes, as strict base64 whose length divides by 4; ' +
                  'at most 10 MiB decoded'
              }
            }
          },
          source: { type: 'string', enum: ['import', 'upload'] }
        }
      }
    }
  }
}

/** What both picture routes answer. */
const pictureAnswer = {
  description:
    'Stored, with the signed URL of the 192 px rendition; or not stored, ' +
    'because it was the picture already held, or because an import met an ' +
    'uploaded picture (`kept: upload`)',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['stored'],
        properties: {
          stored: { type: 'boolean' },
          url: { type: 'string' },
          kept: { type: 'string', enum: ['upload'] }
        }
      }
    }
  }
}

/** How both picture routes are described, after their first line. */
const pictureRules =
  '**Who may call:** an administrator of the team (set on the team, its ' +
  'season or its league, or its owner or manager) or a site ' +
  'administrator. Anyone else gets 403; a team the caller cannot see gets ' +
  '404.\n\n' +
  '**The body:** `image` `{contentType, base64}` and `source` (`import` or ' +
  '`upload`). A content type other than `image/jpeg`, `image/png` or ' +
  '`image/webp` is 415. `base64` that is empty, outside the alphabet or of ' +
  'a length that does not divide by 4 is 400. More than 10 MiB decoded is ' +
  '413. Bytes that do not begin with the declared type\u2019s signature ' +
  '(JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF`, a length, ' +
  '`WEBP`) are 415, as are bytes that are not a picture TeamStation can ' +
  'read.\n\n' +
  '**What is stored:** the picture is normalised to square PNGs of 96 and ' +
  '192 px, named by the hash of their bytes. The same picture again uploads ' +
  'nothing and answers `stored: false`. An `import` never replaces a picture ' +
  'whose source is `upload`, and answers `stored: false, kept: upload`. ' +
  'No picture store configured, or one that does not answer, is 503.'

const sorted = (codes: ReadonlySet<string>): string[] => [...codes].sort()

/** A player a play names: his TeamStation user id, or only a name. */
const gumboPerson = {
  type: 'object',
  properties: {
    id: { type: ['integer', 'null'] },
    fullName: { type: 'string' }
  }
}
const gumboBase = { type: ['string', 'null'], enum: [null, '1B', '2B', '3B'] }
const gumboEventType = {
  type: 'string',
  enum: sorted(STORED_EVENT_TYPES),
  description:
    "MLB's event types (`statsapi.mlb.com/api/v1/eventTypes`) and " +
    "TeamStation's extensions: `final_score` and `score_correction` (an " +
    'import), `ts_manual_placement` (a batter the scorer put ' +
    'on base by hand), `ts_batter_out` (a batter out on a play MLB has no ' +
    'code for) and `ts_batting_order` (a change of batting order). A post ' +
    'may still send `catcher_interference`, `placed_runner` or ' +
    '`manual_placement`; they are stored as `catcher_interf`, ' +
    '`runner_placed` and `ts_manual_placement`. It may also send the ' +
    "names older imports used, each stored as MLB's or " +
    "TeamStation's code: `runner_out` as `other_out`, `batter_out` as " +
    '`field_out`, `catcher_s_interference` as `catcher_interf`, ' +
    '`fc_double_play` as `double_play`, `offensive_interference` as ' +
    '`batter_interference`, `batter_put_on_base` as `ts_manual_placement` ' +
    'and `inning_changed_by_scorekeeper` as `final_score`.'
}
const gumboPosition = {
  type: 'object',
  required: ['code', 'name', 'type', 'abbreviation'],
  properties: {
    code: { type: 'string', enum: sorted(POSITION_CODES) },
    name: { type: 'string' },
    type: { type: 'string' },
    abbreviation: { type: 'string' }
  }
}
const gumboCount = {
  type: 'object',
  properties: {
    balls: { type: 'integer' },
    strikes: { type: 'integer' },
    outs: { type: 'integer' }
  }
}

/**
 * The stored play: a standard MLB Gumbo play, in the shape of the live feed
 * (`statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`, `liveData.plays`).
 */
const gumboSchemas = {
  GumboPlay: {
    type: 'object',
    description:
      'One play as MLB’s live feed writes it (`liveData.plays.allPlays[]`), ' +
      'with its codes on the MLB lists checked in under ' +
      '`src/common/gumbo/reference/`. `npm run validate-gumbo` checks every ' +
      'stored play against them. TeamStation adds only the `teamStation` ' +
      'record, the `ts_` event types and `about.halfOuts`. A play another ' +
      'service posted carries what that service knew; the stats builder ' +
      'needs the fields the events route lists.',
    required: ['about', 'result'],
    properties: {
      about: {
        type: 'object',
        required: ['atBatIndex'],
        properties: {
          atBatIndex: { type: 'integer' },
          inning: { type: ['integer', 'null'] },
          halfInning: {
            type: ['string', 'null'],
            enum: ['top', 'bottom', null]
          },
          isTopInning: { type: 'boolean' },
          isComplete: { type: 'boolean' },
          isScoringPlay: { type: 'boolean' },
          hasOut: { type: 'boolean' },
          hasReview: { type: 'boolean' },
          startTime: { type: ['string', 'null'], format: 'date-time' },
          endTime: { type: ['string', 'null'], format: 'date-time' },
          halfOuts: {
            type: 'integer',
            description:
              'TeamStation extension, written by the server on the last ' +
              'play of each half: the outs the half ended with. An imported ' +
              "half's can come from an Inning Ended marker and differ from " +
              "the play's `count.outs`."
          }
        }
      },
      result: {
        type: 'object',
        required: ['eventType'],
        properties: {
          type: { type: 'string', enum: ['atBat'] },
          event: {
            type: 'string',
            description:
              "MLB's name for the event type (`Forceout`, `Sac Bunt`); a " +
              '`field_out` is `Groundout`, `Flyout`, `Lineout`, `Pop Out` or a ' +
              'bunt out.'
          },
          eventType: gumboEventType,
          description: { type: 'string' },
          rbi: { type: ['integer', 'null'] },
          awayScore: { type: ['integer', 'null'] },
          homeScore: { type: ['integer', 'null'] },
          isOut: { type: 'boolean' }
        }
      },
      count: gumboCount,
      matchup: {
        type: 'object',
        properties: {
          batter: gumboPerson,
          batSide: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: ['L', 'R', 'S'] },
              description: { type: 'string' }
            }
          },
          pitcher: gumboPerson,
          pitchHand: {
            type: 'object',
            description:
              'Written when the roster knows how the pitcher throws.',
            properties: {
              code: { type: 'string', enum: ['L', 'R'] },
              description: { type: 'string' }
            }
          }
        }
      },
      runners: {
        type: 'array',
        items: { $ref: '#/components/schemas/GumboRunner' }
      },
      playEvents: {
        type: 'array',
        items: {
          oneOf: [
            { $ref: '#/components/schemas/GumboPitchEvent' },
            { $ref: '#/components/schemas/GumboActionEvent' }
          ]
        }
      },
      pitchIndex: { type: 'array', items: { type: 'integer' } },
      actionIndex: { type: 'array', items: { type: 'integer' } },
      runnerIndex: { type: 'array', items: { type: 'integer' } },
      credits: {
        type: 'array',
        description:
          'Who a highlight of this play credits, by `creditUserId`: the ' +
          'batter, the pitcher or the fielders, and every runner who scored ' +
          '(`run`) or stole (`stolen_base`). Not a Gumbo field; the credits ' +
          'are what highlights and a player’s plays are read from.',
        items: { type: 'object' }
      },
      teamStation: { $ref: '#/components/schemas/TeamStationRecord' }
    }
  },
  GumboRunner: {
    type: 'object',
    description:
      'One movement of one runner, in the order they happened. A play ' +
      'TeamStation scored carries every key; one another service posted, ' +
      'those it knew.',
    properties: {
      movement: {
        type: 'object',
        properties: {
          originBase: {
            ...gumboBase,
            description:
              'Where he stood when the plate appearance began; null for the ' +
              'batter.'
          },
          start: { ...gumboBase, description: 'Null for the batter.' },
          end: {
            type: ['string', 'null'],
            enum: [null, '1B', '2B', '3B', 'score'],
            description:
              'Null when he is out. A run a third-out force took back holds ' +
              'his base.'
          },
          outBase: {
            type: ['string', 'null'],
            enum: [null, '1B', '2B', '3B', '4B']
          },
          isOut: { type: 'boolean' },
          outNumber: { type: ['integer', 'null'] }
        }
      },
      details: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          eventType: {
            ...gumboEventType,
            description:
              "The play's event type, or the action's that moved him " +
              '(`wild_pitch`, `stolen_base_2b`, `runner_placed`, …).'
          },
          movementReason: {
            type: ['string', 'null'],
            enum: [null, ...sorted(MOVEMENT_REASONS)],
            description:
              "MLB's runner detail types (`api/v1/runnerDetailTypes`) and " +
              "the feed's `r_adv_play`; null for the batter."
          },
          runner: gumboPerson,
          responsiblePitcher: {
            type: ['object', 'null'],
            description:
              'The pitcher charged with him, `{id}`, on every scoring runner ' +
              "and on a walked batter's own entry.",
            properties: { id: { type: ['integer', 'null'] } }
          },
          isScoringEvent: { type: 'boolean' },
          rbi: { type: 'boolean' },
          earned: { type: 'boolean' },
          teamUnearned: { type: 'boolean' },
          playIndex: {
            type: 'integer',
            description: 'The index of the play event that moved him.'
          }
        }
      },
      credits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['player', 'credit'],
          properties: {
            player: gumboPerson,
            position: {
              ...gumboPosition,
              description: 'Left out for a fielder not on defence.'
            },
            credit: {
              type: 'string',
              description:
                '`f_putout`, `f_assist`, `f_fielded_ball`, ' +
                '`f_fielding_error`, `f_throwing_error`, …'
            }
          }
        }
      }
    }
  },
  GumboPitchEvent: {
    type: 'object',
    required: ['index', 'isPitch', 'type', 'details'],
    properties: {
      index: { type: 'integer' },
      pitchNumber: { type: 'integer' },
      isPitch: { type: 'boolean', enum: [true] },
      type: { type: 'string', enum: ['pitch'] },
      details: {
        type: 'object',
        properties: {
          call: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: sorted(PITCH_CODES) },
              description: { type: 'string' }
            }
          },
          code: {
            type: 'string',
            enum: sorted(PITCH_CODES),
            description:
              "MLB's pitch codes (`api/v1/pitchCodes`). TeamStation writes " +
              '`B`, `C`, `S`, `F`, `T`, `L` and `H` from the call, and for the ' +
              'ball in play `E` when it scored a run, else `X` when it made an ' +
              'out, else `D`. A dropped third strike is an `S`.'
          },
          description: { type: 'string' },
          isInPlay: { type: 'boolean' },
          isStrike: { type: 'boolean' },
          isBall: { type: 'boolean' },
          isOut: { type: 'boolean' },
          hasReview: { type: 'boolean' }
        }
      },
      count: { ...gumboCount, description: 'The count after the pitch.' },
      pitchData: {
        type: 'object',
        description:
          'Only what the scorer gave of the pitch: its speed and its zone. ' +
          'TeamStation measures nothing, so it writes no `coordinates` or ' +
          'other tracking.',
        properties: {
          startSpeed: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Miles an hour, to a tenth.'
          },
          zone: {
            type: 'integer',
            description:
              "MLB's zone as the catcher sees it: 1-9 the strike zone from " +
              'top left, 11-14 the corners outside it.'
          }
        }
      },
      hitData: {
        type: 'object',
        description:
          'On the pitch put in play only, and only what the scorer gave. ' +
          '`launchAngle` is the angle the scorer dragged on the field. ' +
          '`totalDistance` and `coordinates` are where the scorer put the ' +
          "ball, sized by the game's fence distance (`fenceDistanceFt` on " +
          '`GET /games/{gameId}`, 200 feet unless the game, its season or ' +
          'its league says otherwise). TeamStation writes no speed; a ' +
          'dictated angle, the untouched default, or one estimated from a ' +
          'trajectory alone stays in the `teamStation` record.',
        properties: {
          launchAngle: {
            type: 'number',
            description: 'Degrees, -90 to 90, as the scorer dragged it.'
          },
          totalDistance: {
            type: 'number',
            exclusiveMinimum: 0,
            description:
              'Whole feet from home plate to where the scorer put the ball: ' +
              "a ball on the fence went the game's fence distance. Only when " +
              'the scorer placed the ball.'
          },
          trajectory: { type: 'string', enum: sorted(HIT_TRAJECTORIES) },
          location: {
            type: 'string',
            description: "The fielder's position code, e.g. `8`."
          },
          coordinates: {
            type: 'object',
            description:
              "MLB's 250 by 250 spray chart, home plate at (125, 204), 2.4 " +
              "feet to a unit: the game's fence is its distance over 2.4 " +
              'units from home, the foul poles at 45°.',
            properties: {
              coordX: { type: 'number' },
              coordY: { type: 'number' }
            }
          }
        }
      },
      player: gumboPerson,
      startTime: { type: ['string', 'null'] },
      endTime: { type: ['string', 'null'] }
    }
  },
  GumboActionEvent: {
    type: 'object',
    required: ['index', 'isPitch', 'type', 'details'],
    properties: {
      index: { type: 'integer' },
      isPitch: { type: 'boolean', enum: [false] },
      isBaseRunningPlay: {
        type: 'boolean',
        description: 'Present, and true, only on a base-running action.'
      },
      isSubstitution: {
        type: 'boolean',
        description:
          'Present, and true, on a lineup change: `offensive_substitution`, ' +
          '`defensive_substitution`, `defensive_switch`, ' +
          "`pitching_substitution` or `ts_batting_order`. As in MLB's feed, " +
          "a side's changes to its fielders from when it leaves the field " +
          'to its first pitch back in it are written as their net change at ' +
          'the start of the first play it fields. A pinch hitter is written ' +
          'at the start of the first play he bats in, and a pinch runner ' +
          'where he takes the base. A `ts_batting_order` names only players ' +
          'who have appeared in play.'
      },
      type: { type: 'string', enum: ['action'] },
      details: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          event: { type: 'string' },
          eventType: gumboEventType,
          awayScore: { type: 'integer', description: 'After the action.' },
          homeScore: { type: 'integer', description: 'After the action.' },
          isScoringPlay: { type: 'boolean' },
          isOut: { type: 'boolean' },
          hasReview: { type: 'boolean' }
        }
      },
      count: gumboCount,
      player: gumboPerson,
      position: gumboPosition,
      battingOrder: {
        type: 'string',
        description:
          'On an offensive substitution and a defensive switch: the slot ' +
          'times 100 plus how many have come in at it, e.g. `601`.'
      },
      replacedPlayer: gumboPerson,
      startTime: { type: ['string', 'null'] },
      endTime: { type: ['string', 'null'] }
    }
  },
  GumboCurrentPlay: {
    type: 'object',
    description:
      'The at-bat in progress, kept on the game rather than as a play: a ' +
      '`GumboPlay` with `about.isComplete` false and no `result`, since it ' +
      'has no outcome yet. When the batter due is already on base (the ' +
      'inning ended on a runner) it carries only its place in the game and ' +
      'the `teamStation` record.',
    required: ['about'],
    properties: {
      about: {
        type: 'object',
        required: ['atBatIndex', 'isComplete'],
        properties: {
          atBatIndex: { type: 'integer' },
          inning: { type: ['integer', 'null'] },
          halfInning: {
            type: ['string', 'null'],
            enum: ['top', 'bottom', null]
          },
          isComplete: { type: 'boolean', enum: [false] }
        }
      },
      count: gumboCount,
      matchup: { type: 'object' },
      runners: {
        type: 'array',
        items: { $ref: '#/components/schemas/GumboRunner' }
      },
      playEvents: {
        type: 'array',
        items: {
          oneOf: [
            { $ref: '#/components/schemas/GumboPitchEvent' },
            { $ref: '#/components/schemas/GumboActionEvent' }
          ]
        }
      },
      teamStation: { $ref: '#/components/schemas/TeamStationRecord' }
    }
  },
  TeamStationRecord: {
    type: 'object',
    description:
      'TeamStation extension, on every play it scored and on the at-bat in ' +
      "progress: the scorer's action log the play is rebuilt from. " +
      '`setupBefore` is the lineups before it, `actions` the actions in the ' +
      "engine's own vocabulary, and `detail` the scorer's own picks and " +
      'estimates (trajectory, launch angle). Replay and undo read it; ' +
      '`npm run refold-scored-games` rebuilds the rest of the play from it.' +
      ' `version` is 1; a post whose record has any other version is ' +
      'refused with 400.',
    required: ['version', 'setupBefore', 'actions'],
    properties: {
      version: { type: 'integer', enum: [1] },
      setupBefore: { type: 'object' },
      actions: { type: 'array', items: { type: 'object' } },
      detail: { type: 'object' }
    }
  }
}

export function openApiDocument(version: string): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'TeamStation',
      version,
      description:
        'Teams, games, videos and the plays underneath them. Every failure ' +
        'answers with the same shape, and every request and response is ' +
        'checked by a cleaner on both sides.'
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' }
      },
      schemas: {
        ...gumboSchemas,
        ApiError: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'badRequest',
                'unauthorized',
                'forbidden',
                'notFound',
                'conflict',
                'tooLarge',
                'unsupportedMedia',
                'rateLimited',
                'internal',
                'unavailable'
              ]
            },
            message: { type: 'string' },
            details: {}
          }
        },
        Health: {
          type: 'object',
          required: ['status', 'version', 'database', 'migrations'],
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            version: { type: 'string' },
            database: { type: 'string', enum: ['ok', 'unreachable'] },
            migrations: { type: 'integer' },
            uptimeSec: { type: 'integer' },
            pid: { type: 'integer' },
            dictation: {
              type: 'boolean',
              description: 'Whether dictation is configured on this server'
            },
            dictationModels: {
              type: 'array',
              items: { type: 'string' },
              description: 'The LLMs dictation has a key for on this server'
            }
          }
        },
        User: {
          type: 'object',
          required: ['id', 'displayName', 'isAdmin'],
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            email: { type: ['string', 'null'] },
            isAdmin: { type: 'boolean' }
          }
        },
        LiveStream: {
          type: 'object',
          required: ['gameId', 'exists'],
          description:
            'A game\u2019s live stream. `url` is present only in the reply to ' +
            'a request that asked for it by name \u2014 creating, revealing ' +
            'or rotating \u2014 because it carries the key, and anybody ' +
            'holding that can publish video into this game.',
          properties: {
            gameId: { type: 'string' },
            exists: { type: 'boolean' },
            id: { type: 'string' },
            teamId: { type: 'string' },
            keyPrefix: {
              type: 'string',
              description:
                'Enough to tell two keys apart, far too little to use'
            },
            state: {
              type: 'string',
              enum: ['idle', 'publishing', 'ended', 'revoked']
            },
            opensAt: { type: 'string', format: 'date-time' },
            closesAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description:
                'When somebody ended it. Null while it is still good — a key ' +
                'has no clock at either end, so it can be tried before the ' +
                'game and after it.'
            },
            videoId: { type: ['string', 'null'] },
            lastError: { type: ['string', 'null'] },
            status: {
              type: ['object', 'null'],
              description:
                'What the ingest last reported: the stream arriving, and each ' +
                'leg it is being sent to. Never carries a key.'
            },
            url: {
              type: 'string',
              description: 'The whole thing, key and all, for pasting'
            }
          }
        },
        Invite: {
          type: 'object',
          required: ['id', 'code', 'url', 'scopeType', 'scopeId', 'uses'],
          description:
            'A standing offer to let somebody watch a league, a season or a ' +
            'team. `url` is the address to hand out, which is the same ' +
            '`/i/<code>` path PeerTube used so that links already in ' +
            'mailboxes keep working.',
          properties: {
            id: { type: 'string' },
            code: { type: 'string' },
            url: { type: 'string' },
            scopeType: { type: 'string', enum: ['league', 'season', 'team'] },
            scopeId: { type: 'string' },
            label: { type: ['string', 'null'] },
            maxUses: { type: ['integer', 'null'] },
            uses: { type: 'integer' },
            expiresAt: { type: ['string', 'null'], format: 'date-time' },
            revokedAt: { type: ['string', 'null'], format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            problem: {
              type: ['string', 'null'],
              enum: ['revoked', 'expired', 'exhausted', null],
              description: 'Why it no longer works, or null while it does'
            }
          }
        },
        InviteInfo: {
          type: 'object',
          required: ['code', 'valid', 'scope', 'signedIn', 'alreadyIn'],
          description: 'What is behind a code, for the screen its link opens.',
          properties: {
            code: { type: 'string' },
            valid: { type: 'boolean' },
            problem: {
              type: ['string', 'null'],
              enum: ['revoked', 'expired', 'exhausted', null]
            },
            scope: {
              type: 'object',
              required: ['kind', 'id', 'name'],
              properties: {
                kind: { type: 'string', enum: ['league', 'season', 'team'] },
                id: { type: 'string' },
                name: { type: 'string' }
              }
            },
            signedIn: { type: 'boolean' },
            alreadyIn: { type: 'boolean' }
          }
        },
        ScopePerson: {
          type: 'object',
          required: ['userId', 'displayName', 'emails', 'createdAt'],
          description:
            'One person with access, and every level it comes through. Never ' +
            'the strongest grant alone: somebody often holds two, and an ' +
            'administrator who removes one and sees nothing change has been ' +
            'told a half-truth.',
          properties: {
            userId: { type: 'string' },
            displayName: { type: 'string' },
            emails: { type: 'array', items: { type: 'string' } },
            teams: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            seasons: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            leagues: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            grants: {
              type: 'array',
              description:
                'Every role they hold in this tree, one entry per level. A ' +
                'role set above the level being managed appears under that ' +
                'level, with its name.',
              items: { $ref: '#/components/schemas/RoleGrant' }
            },
            adminOf: {
              type: 'array',
              description:
                '`grants` narrowed to `admin`, for apps from before the ' +
                'role flags.',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['league', 'season', 'team']
                  },
                  id: { type: 'string' },
                  name: { type: 'string' }
                }
              }
            },
            createdAt: { type: 'string', format: 'date-time' },
            lastSignInAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'Null for an account nobody has ever used'
            },
            lastSeenAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description:
                'The last request on any of their sessions, which is later ' +
                'than the sign-in for anybody who stays signed in'
            }
          }
        },
        LineupPerson: {
          type: 'object',
          required: ['userId', 'name', 'jersey'],
          description:
            'A player in a lineup: his user id, or null for a placeholder ' +
            'named at the field, the short name the scoring screen shows ' +
            '(never a full name), and his jersey.',
          properties: {
            userId: { type: ['integer', 'null'] },
            name: { type: 'string' },
            jersey: { type: 'string' }
          }
        },
        Lineup: {
          type: 'object',
          required: ['batters', 'defense'],
          properties: {
            batters: {
              type: 'array',
              description: 'The batting order; the first leads off.',
              items: { $ref: '#/components/schemas/LineupPerson' }
            },
            defense: {
              type: 'object',
              description:
                'Each position, P, C, 1B, 2B, SS, 3B, LF, CF and RF, and who ' +
                'plays it, or null.',
              additionalProperties: {
                oneOf: [
                  { $ref: '#/components/schemas/LineupPerson' },
                  { type: 'null' }
                ]
              }
            }
          }
        },
        LineupChange: {
          type: 'object',
          required: [
            'atBatIndex',
            'inning',
            'half',
            'side',
            'eventType',
            'player',
            'position',
            'battingOrder',
            'replaced',
            'description'
          ],
          description:
            'One stored Gumbo substitution event, announced in the play at ' +
            '`atBatIndex` where MLB announces it: a pinch hitter in the play ' +
            'he bats in, a pinch runner where he takes the base, and a ' +
            "side's fielding changes at the start of the first play it fields.",
          properties: {
            atBatIndex: { type: 'integer' },
            inning: { type: 'integer' },
            half: { type: 'string', enum: ['top', 'bottom'] },
            side: {
              type: 'string',
              enum: ['away', 'home'],
              description: 'The side the player belongs to'
            },
            eventType: {
              type: 'string',
              enum: [
                'offensive_substitution',
                'defensive_substitution',
                'defensive_switch',
                'pitching_substitution',
                'ts_batting_order'
              ]
            },
            player: { $ref: '#/components/schemas/LineupPerson' },
            position: {
              type: ['string', 'null'],
              description: 'The Gumbo abbreviation: PH, PR, SS, P, …'
            },
            battingOrder: {
              type: ['string', 'null'],
              description: 'The place in the order as MLB writes it, `601`'
            },
            replaced: {
              oneOf: [
                { $ref: '#/components/schemas/LineupPerson' },
                { type: 'null' }
              ]
            },
            description: { type: 'string' }
          }
        },
        SideLineups: {
          type: 'object',
          required: ['teamId', 'teamName', 'start', 'changes', 'current'],
          properties: {
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            start: {
              description:
                'The lineup the side began with; null until the game has ' +
                'begun, and for a game TeamStation did not score.',
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            },
            changes: {
              type: 'array',
              items: { $ref: '#/components/schemas/LineupChange' }
            },
            current: {
              description:
                'The lineup as it stands, including a change not announced ' +
                'yet, such as a pinch hitter waiting to bat. Null for a game ' +
                'TeamStation did not score, or whose record no longer replays.',
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            }
          }
        },
        DjSide: {
          type: 'object',
          required: [
            'teamId',
            'teamName',
            'source',
            'canEditWalkUp',
            'batters'
          ],
          properties: {
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            source: {
              description:
                "Where the order came from: the game's own lineup as it " +
                "stands, the team's default before the game has one, or its " +
                'players by jersey number when it has neither.',
              enum: ['lineup', 'default', 'roster']
            },
            canEditWalkUp: {
              type: 'boolean',
              description: "Whether the caller keeps this team's walk-up songs."
            },
            batters: {
              type: 'array',
              items: {
                type: 'object',
                required: ['userId', 'name', 'walkUpSong'],
                properties: {
                  userId: {
                    description: 'Null for a placeholder named at the field.',
                    oneOf: [{ type: 'integer' }, { type: 'null' }]
                  },
                  name: { type: 'string' },
                  walkUpSong: {
                    oneOf: [
                      { $ref: '#/components/schemas/WalkUpSong' },
                      { type: 'null' }
                    ]
                  }
                }
              }
            }
          }
        },
        DefaultLineup: {
          type: 'object',
          required: ['lineup', 'fromGameId', 'setAt'],
          description:
            "A team's default lineup, or all three null for a team with none.",
          properties: {
            lineup: {
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            },
            fromGameId: { type: ['string', 'null'] },
            setAt: { type: ['string', 'null'], format: 'date-time' }
          }
        },
        Role: {
          type: 'string',
          enum: ['admin', 'coach', 'scorekeeper', 'songkeeper', 'videographer'],
          description:
            'What somebody may do on a league, season or team and everything ' +
            'inside it. `admin` holds every flag without having one set.'
        },
        WalkUpSong: {
          type: 'object',
          required: [
            'provider',
            'providerId',
            'title',
            'artist',
            'durationMs',
            'startMs',
            'endMs'
          ],
          description:
            "A player's walk-up song on one team, and the clip of it that " +
            `plays: \`startMs\` to \`endMs\`, within \`durationMs\`, ` +
            `${CLIP_MIN_MS / 1000} to ${CLIP_MAX_MS / 1000} seconds long. ` +
            'Text is trimmed; an empty optional field is null.',
          properties: {
            provider: { type: 'string', enum: [...WALK_UP_PROVIDERS] },
            providerId: {
              type: 'string',
              description:
                'The Apple Music catalog id, or for a file on a phone `lf:` ' +
                'and the first 16 hex characters of a sha256 of its ' +
                'normalised title, artist and whole-second duration.'
            },
            isrc: {
              type: ['string', 'null'],
              description: 'Read without hyphens, in capitals.'
            },
            title: { type: 'string', maxLength: 300 },
            artist: { type: 'string', maxLength: 300 },
            album: { type: ['string', 'null'], maxLength: 300 },
            artworkUrl: {
              type: ['string', 'null'],
              description: 'An http or https address.'
            },
            durationMs: { type: 'integer', minimum: 1 },
            startMs: { type: 'integer', minimum: 0 },
            endMs: { type: 'integer' }
          }
        },
        RoleFlag: {
          type: 'string',
          enum: ['coach', 'scorekeeper', 'songkeeper', 'videographer']
        },
        RoleGrant: {
          type: 'object',
          required: ['kind', 'id', 'name', 'roles'],
          properties: {
            kind: { type: 'string', enum: ['league', 'season', 'team'] },
            id: { type: 'string' },
            name: { type: 'string' },
            roles: {
              type: 'array',
              items: { $ref: '#/components/schemas/Role' }
            }
          }
        },
        ScopeGrant: {
          type: 'object',
          required: ['id', 'name', 'role'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' }
          }
        },
        PendingPerson: {
          type: 'object',
          required: ['inviteId', 'email', 'code', 'invitedAt'],
          description:
            'Somebody invited by address who has not opened the link yet.',
          properties: {
            inviteId: { type: 'string' },
            email: { type: 'string' },
            code: { type: 'string' },
            invitedAt: { type: 'string', format: 'date-time' }
          }
        },
        ManagePage: {
          type: 'object',
          required: ['scope', 'tree', 'people', 'pending', 'invites'],
          properties: {
            scope: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['league', 'season', 'team'] },
                id: { type: 'string' },
                name: { type: 'string' }
              }
            },
            tree: {
              type: 'object',
              description:
                'The levels around this one, named, so a tick can say which',
              properties: {
                leagues: { type: 'array', items: namedThing },
                seasons: { type: 'array', items: namedThing },
                teams: { type: 'array', items: namedThing }
              }
            },
            people: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopePerson' }
            },
            pending: {
              type: 'array',
              items: { $ref: '#/components/schemas/PendingPerson' }
            },
            invites: {
              type: 'array',
              items: { $ref: '#/components/schemas/Invite' }
            }
          }
        },
        Session: {
          type: 'object',
          required: ['token', 'expiresAt', 'user'],
          properties: {
            token: {
              type: 'string',
              description: 'Shown once. Only its hash is stored.'
            },
            expiresAt: { type: 'string', format: 'date-time' },
            user: { $ref: '#/components/schemas/User' }
          }
        }
      }
    },
    paths: {
      '/health': {
        get: {
          summary:
            'Whether this worker can serve, and whether it can see the database',
          responses: {
            200: {
              description: 'Healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' }
                }
              }
            },
            503: {
              description: 'The database is unreachable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' }
                }
              }
            }
          }
        }
      },
      '/auth/password': {
        post: {
          summary: 'Sign in with an e-mail address and a password',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string' },
                    password: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Signed in',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/email-code': {
        post: {
          summary: 'Ask for a sign-in code by e-mail',
          description:
            'Always answers 202, whether or not the address has an account, ' +
            'so this cannot be used to find out who is registered.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            202: {
              description: 'A code was sent if there was somebody to send it to'
            },
            400: errorResponse
          }
        }
      },
      '/auth/email-code/verify': {
        post: {
          summary: 'Exchange an e-mailed code for a session',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'code'],
                  properties: {
                    email: { type: 'string' },
                    code: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Signed in',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/logout': {
        post: {
          summary: 'Revoke the session this request used',
          security: [{ bearer: [] }],
          responses: { 204: { description: 'Revoked' }, 401: errorResponse }
        }
      },
      '/me/roles': {
        get: {
          summary: 'What the caller may do, team by team',
          description:
            'Every team on which the caller holds any role, with the roles ' +
            'they hold there: set on the team, carried down from its season ' +
            'or league, and every role on a team they administer. A site ' +
            'admin holds every role on every team.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The roles on each team',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['teams'],
                    properties: {
                      teams: {
                        type: 'object',
                        additionalProperties: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Role' }
                        }
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/me': {
        get: {
          summary: 'Who this token belongs to',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The signed-in user',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/User' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/teams': {
        get: {
          summary: 'The teams this person belongs to, or a season\u2019s teams',
          description:
            'Without `season`: full teams only, never an opponent from ' +
            'outside a season. A site administrator gets every team; anybody ' +
            'else the teams they may see.\n\n' +
            '`season` may be repeated, and lists the teams of those seasons ' +
            'instead, whoever the caller belongs to: its full teams, and ' +
            'with `kind=external` or `kind=any` the external teams on either ' +
            'side of its games (`kind=external` lists only those). A season ' +
            'the caller can neither see nor schedule games in answers 404. A ' +
            'merged team is listed as the team it was merged into, and each ' +
            'team once. `kind` defaults to `full`; any other value needs ' +
            '`season` (400 `kind needs season`).\n\n' +
            'Each team carries `externalIds`, the ids other systems know it ' +
            'by (any system or kind), sorted, and `kind`, `full` or ' +
            '`external`. `externalId` may be repeated, and narrows the list ' +
            'to teams holding any of those ids, with what the caller may see ' +
            'unchanged; an empty one is refused.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'externalId',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: "Another service's ids for the team"
            },
            {
              name: 'season',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description:
                'Seasons whose teams to list. Leaving it out lists the ' +
                'teams this person belongs to.'
            },
            {
              name: 'kind',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['full', 'external', 'any'],
                default: 'full'
              },
              description:
                'Which teams of the seasons: their own, the external teams ' +
                'their games were played against, or both. Needs `season` ' +
                'unless `full`.'
            }
          ],
          responses: {
            200: { description: 'The teams, which may be an empty list' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary:
            'Make a team, standalone or in a season, known by external ids',
          description:
            '**Who may call:** anybody signed in. The caller becomes the ' +
            'administrator of the team, and of a season the call makes, and, ' +
            'unless they are a site administrator, the team\u2019s owner, so ' +
            'it lists among their teams. ' +
            'Putting the team in an existing season takes an administrator ' +
            'of that season or its league, or a site administrator.\n\n' +
            '**The body:** `name` is trimmed and 1-100 characters. `season` ' +
            'is optional; without it the team is standalone, in no season. ' +
            'It is `{id}`, an existing season (404 when there is none, 403 ' +
            'when the caller does not administer it or its league), or ' +
            '`{name, year}`: the first season with that name in that year, ' +
            'ignoring case and outer spaces, that the caller administers, ' +
            'else a new one in no league. `name` is ' +
            '1-100 characters after trimming and `year` a whole year from ' +
            '1900 to 2200. `externalIds` is optional, at most 20 of ' +
            '`{system, id, kind}`, with `system` matching ' +
            '`^[a-z][a-zA-Z0-9]{0,31}$` and `id` and `kind` non-empty.\n\n' +
            '**What it does:** when any of the external ids (the same ' +
            'system, kind and id) already names a team the caller can see, ' +
            'nothing is made and the answer is 200 with that team (the one ' +
            'it was merged into, if it was) and `season: null`. The ' +
            'body\u2019s other ids nothing holds are recorded on it only when ' +
            'the caller administers it. An id on a ' +
            'team the caller cannot see, or on something other than a team, ' +
            'is 409, and nothing is made. Otherwise, in one transaction, a ' +
            'full team is made, put in the season, and given the ids, and ' +
            'the answer is 201 with the season and whether this call made ' +
            'it, or `season: null` for a standalone team.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    season: {
                      nullable: true,
                      oneOf: [
                        {
                          type: 'object',
                          required: ['id'],
                          properties: { id: { type: 'string' } }
                        },
                        {
                          type: 'object',
                          required: ['name', 'year'],
                          properties: {
                            name: {
                              type: 'string',
                              minLength: 1,
                              maxLength: 100
                            },
                            year: {
                              type: 'integer',
                              minimum: 1900,
                              maximum: 2200
                            }
                          }
                        }
                      ]
                    },
                    externalIds: {
                      type: 'array',
                      maxItems: 20,
                      items: {
                        type: 'object',
                        required: ['system', 'id', 'kind'],
                        properties: {
                          system: {
                            type: 'string',
                            pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                          },
                          id: { type: 'string', minLength: 1 },
                          kind: { type: 'string', minLength: 1 }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                'An external id already named this team; nothing was made',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name', 'created', 'season'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      created: { type: 'boolean', enum: [false] },
                      season: { type: 'null' }
                    }
                  }
                }
              }
            },
            201: {
              description:
                'The team was made, in this season or, with `season: null`, ' +
                'standalone',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name', 'created', 'season'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      created: { type: 'boolean', enum: [true] },
                      season: {
                        type: 'object',
                        nullable: true,
                        required: ['id', 'name', 'year', 'created'],
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          year: { type: 'integer' },
                          created: { type: 'boolean' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/teams/{teamId}/games': {
        get: {
          summary: "A team's games, newest first",
          description:
            'Answers 404 rather than 403 for a team the caller may not see, ' +
            'so that probing cannot reveal which teams exist.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'Games, newest first, with a video count' },
            404: errorResponse
          }
        },
        post: {
          summary: "Schedule a team's games",
          description:
            'Schedules up to 200 games for the team in one call, and answers ' +
            'each row on its own, in order. Rows are applied one at a time, ' +
            'each in its own transaction, so one refused row stops nothing.\n\n' +
            '**Who may call:** a site admin, an admin of the team (an admin ' +
            '`scope_roles` team row, or its owner or manager), or an admin of ' +
            "a season the team plays in or of that season's league. A plain " +
            'member, parent or spectator gets 403; a team the caller can ' +
            'neither see nor administer gets 404. A season or league admin ' +
            'may only schedule into a season they administer: a row into ' +
            'another season is `forbidden`.\n\n' +
            '**A row:** `opponent` (`{teamId, externalId?}`, or ' +
            '`{name, externalId?}` with ' +
            'a name of 1-120 characters) and `side` (`home` or `away`, the ' +
            'side this team plays on) are needed to create a game. On a ' +
            'matched one, `opponent` may change the opponent and `side` may ' +
            'swap the sides (below). ' +
            '`startAt` is required, an ISO 8601 date-time with `Z` or an ' +
            'offset. `seasonId` is optional and must be a season the team is ' +
            "in; without it the season whose dates hold the game's UTC day " +
            "is used (the latest to start), else the team's season of that " +
            'year. `venue` (at most 200 characters) and `status` (`scheduled` ' +
            'or `cancelled`) are optional; omitted, a held game keeps its own. ' +
            '`fenceDistanceFt` (whole feet, 1 to 600) is optional too: ' +
            "omitted, a new game is played to its season's or league's " +
            'fence and a held game keeps its own, as does one with plays. ' +
            '`externalId` is optional `{system, id, kind?}`, with `system` and ' +
            '`kind` matching `^[a-z][a-zA-Z0-9]{0,31}$` and `kind` defaulting ' +
            'to `event`.\n\n' +
            '**What a row does:** with an `externalId`, a game already holding ' +
            'that system and id (of any kind) is matched. Its opponent may ' +
            'change, whatever its status (below); otherwise an `inProgress` ' +
            'or `final` game is left as it is, and a `scheduled` or ' +
            "`cancelled` one takes the row's time, venue, status and fence " +
            'distance, and ' +
            'is `updated` when any of them changed. When the row gives a ' +
            '`side` other than the one this team plays on, the other team is ' +
            'an external one and the game has no plays (none stored and no ' +
            'at-bat under way), its home and away teams swap, their scores ' +
            'with them, and the row is `updated`. A game with plays, or ' +
            'between two full teams, keeps its sides, and the row is ' +
            'answered by its other fields. The season never changes, and a ' +
            'game matched by time rather than by id keeps its sides. ' +
            'Without a match, a game in the same season ' +
            'between the same two teams at the same time takes the id. ' +
            'Otherwise the row creates a game. A row without `externalId` ' +
            'always creates one. An opponent named by `name` is a team of the ' +
            'season with that name, else the oldest external team of that ' +
            'name, else a new external team.\n\n' +
            '**Names:** a `name` finds a team only by the name itself: two ' +
            'names are the same when they are, once trimmed, with runs of ' +
            'spaces made one and case ignored. Any other difference (a ' +
            'trailing number, punctuation, a note in brackets) is another ' +
            'team. A client that knows two spellings are one team names it ' +
            'by `teamId`.\n\n' +
            "**An opponent's id:** `opponent.externalId` is `{system, kind, " +
            'id}`, `system` matching `^[a-z][a-zA-Z0-9]{0,31}$` and `kind` and ' +
            '`id` non-empty, the id another system has for the opponent. ' +
            'With `teamId`, that team is the opponent (an unknown one is ' +
            '`notFound`, this team itself and a merged team are `conflict`), ' +
            'and it takes the id when it is an external team and nothing ' +
            "holds the id. On a matched game, the game's opponent takes it " +
            'the same way when `teamId` names that opponent, before anything ' +
            'else, so a game scored in TeamStation records it too. With ' +
            '`name`, a ' +
            'team already holding it (an external or a full one, followed ' +
            'through merges) is the opponent, whatever the name says, except ' +
            "an external team whose name is not the row's and which is " +
            "named as a placeholder (below), is shared by other teams' " +
            'games, or would by that name be a second team of one name (the ' +
            '`name` already finds a team). For those the opponent is found ' +
            'by `name` ' +
            'alone. Otherwise the opponent is found by name, and an external ' +
            'team found or made that way takes the id when nothing holds it ' +
            'and the `name` is not a placeholder. On a matched game, the ' +
            "game's opponent takes the id when it is an external team, the " +
            "row's `name` finds it by that same rule, and nothing holds the " +
            'id. A full team never takes an id here, and an id something ' +
            'already holds never moves, except one left on a team that no ' +
            'longer exists, which the team found takes over. Recording an ' +
            'opponent id alone leaves the row `unchanged`: the answer ' +
            'describes the game.\n\n' +
            "**A matched game's opponent:** only an external opponent " +
            'changes; a game against a full team keeps it. A placeholder ' +
            '`name`, saying the opponent is not known yet (one starting ' +
            '`TBD`, `TBA`, `To be decided`, `To be announced` or `To be ' +
            'determined`, in any case), leaves the opponent as it is, and ' +
            "takes no id. So does a `name` that is this team's own. A " +
            "`name` that is the opponent's changes nothing, whatever team " +
            "holds the row's id. Otherwise the row's opponent is found by " +
            'its id, as above, then by its `name`: a team of the season or ' +
            'an external team of that name, else a new external team. A ' +
            '`{teamId}` naming the opponent changes nothing; naming another ' +
            "team moves the game to it. When the row's id is held by the game's " +
            "opponent and stands for the row's `name` by the rule above, " +
            "that team is renamed to the row's `name`, in every game it " +
            'plays, and the row is `updated`; otherwise it keeps its name, ' +
            "and this game's opponent is found by the `name` alone. Any other " +
            "team found or made becomes the game's opponent, even after plays " +
            'and a final score, and the row is `updated`: the score, the ' +
            "sides and the plays stay; the plays' batting team, player rows " +
            'and credits, and a camera key filming that side, move to the ' +
            "new team; the game's stats are rebuilt. A team found by the " +
            "row's id takes the row's `name` too. The old team stays, with no " +
            'game if it has none left. A game scored in TeamStation (scored ' +
            'by its scorer, a play carrying its `teamStation` record, or an ' +
            'at-bat under way) keeps its opponent, and the row is answered by ' +
            'its other fields; `GET /events` marks such a game, and one ' +
            'between two full teams, `opponentFixed`. A move onto a full ' +
            'team already playing this team in the same season at the ' +
            "game's time or the row's is a `conflict`: `<team> already has " +
            'this game`.\n\n' +
            '**Answers:** `result` is `created`, `updated`, `unchanged` or ' +
            "`error`, with `gameId` and the game's `status` after the row. " +
            'Error codes: `invalid`, `notFound`, `conflict`, `noSeason`, ' +
            '`forbidden`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['games'],
                  properties: {
                    games: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['startAt'],
                        properties: {
                          opponent: {
                            oneOf: [
                              {
                                type: 'object',
                                required: ['teamId'],
                                properties: {
                                  teamId: { type: 'string' },
                                  externalId: {
                                    type: 'object',
                                    required: ['system', 'kind', 'id'],
                                    properties: {
                                      system: {
                                        type: 'string',
                                        pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                                      },
                                      kind: { type: 'string', minLength: 1 },
                                      id: { type: 'string', minLength: 1 }
                                    }
                                  }
                                }
                              },
                              {
                                type: 'object',
                                required: ['name'],
                                properties: {
                                  name: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 120
                                  },
                                  externalId: {
                                    type: 'object',
                                    required: ['system', 'kind', 'id'],
                                    properties: {
                                      system: {
                                        type: 'string',
                                        pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                                      },
                                      kind: { type: 'string', minLength: 1 },
                                      id: { type: 'string', minLength: 1 }
                                    }
                                  }
                                }
                              }
                            ]
                          },
                          side: { type: 'string', enum: ['home', 'away'] },
                          startAt: { type: 'string', format: 'date-time' },
                          seasonId: { type: 'string' },
                          venue: {
                            type: 'string',
                            nullable: true,
                            maxLength: 200
                          },
                          status: {
                            type: 'string',
                            enum: ['scheduled', 'cancelled']
                          },
                          fenceDistanceFt: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 600
                          },
                          externalId: {
                            type: 'object',
                            required: ['system', 'id'],
                            properties: {
                              system: {
                                type: 'string',
                                pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                              },
                              id: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 200
                              },
                              kind: {
                                type: 'string',
                                pattern: '^[a-z][a-zA-Z0-9]{0,31}$',
                                default: 'event'
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                'One answer per row, in order, and the counts, even when ' +
                'every row failed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['index', 'result'],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'updated', 'unchanged', 'error']
                            },
                            gameId: { type: 'string' },
                            status: {
                              type: 'string',
                              enum: [
                                'scheduled',
                                'inProgress',
                                'final',
                                'cancelled'
                              ]
                            },
                            error: {
                              type: 'object',
                              required: ['code', 'message'],
                              properties: {
                                code: {
                                  type: 'string',
                                  enum: [
                                    'invalid',
                                    'notFound',
                                    'conflict',
                                    'noSeason',
                                    'forbidden'
                                  ]
                                },
                                message: { type: 'string' }
                              }
                            }
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          updated: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players': {
        post: {
          summary: "Add a team's players by external id",
          description:
            'Adds 1 to 200 players in one call, in one transaction, and ' +
            'answers each row in order. Each row is a person another system ' +
            'knows by `externalId`.\n\n' +
            '**Who may call:** an administrator of the team (set on the ' +
            'team, its season or its league, or its owner or manager) or a ' +
            'site administrator. Anyone else gets 403; a team the caller ' +
            'cannot see gets 404. A person an external id already names is ' +
            'added to the team wherever else they are.\n\n' +
            '**A row:** `firstName` and `lastName` (trimmed, at most 100 ' +
            'characters, either may be empty), `jersey` (at most 3 ' +
            'characters), `bats` (`left`, `right` or `switch`), `throws` ' +
            '(`left` or `right`) and `externalId` `{system, kind, id}`, with ' +
            '`system` matching `^[a-z][a-zA-Z0-9]{0,31}$`. One malformed row ' +
            'refuses the call with a 400 naming it.\n\n' +
            '**What a row does:** the user holding the external id (merged ' +
            'accounts followed to the one they became) is the player; ' +
            'otherwise a new user is made, who cannot sign in, named `first ' +
            'last` or `Unknown player`, with the id recorded on them. That ' +
            "user's membership of the team is made a player's: a new one is " +
            'a `member` with the jersey, and an existing one keeps its jersey ' +
            'unless it had none. Each of `bats` and `throws` sent replaces ' +
            'an imported one and is never written over a coach\u2019s; a ' +
            'hand not sent is left as it is. An id held by something that ' +
            "is not a user is that row's `conflict`; the other rows still " +
            'apply.\n\n' +
            '**Answers:** `result` is `created` (a new user), `joined` (an ' +
            'existing user newly a player here), `unchanged` (already a ' +
            'player here) or `error`, with the `userId`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['players'],
                  properties: {
                    players: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['externalId'],
                        properties: {
                          ...personNames,
                          jersey: { type: 'string', maxLength: 3 },
                          bats: {
                            type: 'string',
                            enum: ['left', 'right', 'switch']
                          },
                          throws: { type: 'string', enum: ['left', 'right'] },
                          externalId: memberExternalId
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'One answer per row, in order, and the counts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['index', 'result'],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'joined', 'unchanged', 'error']
                            },
                            userId: { type: 'integer' },
                            error: memberRowError
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          joined: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/adults': {
        post: {
          summary: "Add a team's parents, followers and staff by external id",
          description:
            'Adds 1 to 200 adults in one call, in one transaction, and ' +
            'answers each row in order. Nobody is mailed, and nothing is ' +
            'ever taken away. Add the players first, so guardian links find ' +
            'them.\n\n' +
            '**Who may call:** an administrator of the team (set on the ' +
            'team, its season or its league, or its owner or manager) or a ' +
            'site administrator. Anyone else gets 403; a team the caller ' +
            'cannot see gets 404.\n\n' +
            '**A row:** `firstName` and `lastName` (trimmed, at most 100 ' +
            'characters, either may be empty), `email` (optional; trimmed, ' +
            'lower-cased, with an `@`), `externalId` `{system, kind, id}`, ' +
            "`guardianOf` (the players' external ids, possibly none) and " +
            '`staff` (true or false). One malformed row refuses the call with ' +
            'a 400 naming it.\n\n' +
            '**Who a row is:** the user holding the external id (merged ' +
            'accounts followed); otherwise the user holding the address, ' +
            'who then gets the external id only when the caller is a site ' +
            'administrator (otherwise the row says `externalIdNotAttached`); ' +
            'otherwise a new user, named ' +
            '`first last` or `Unknown adult`, who may sign in by e-mail code ' +
            "when there is an address. An existing user's sign-in setting is " +
            'never changed.\n\n' +
            '**The address:** already theirs, nothing changes. Held by ' +
            'nobody, it is attached, as their primary address, to an account ' +
            'this call made; to an account already here only when the ' +
            'caller is a site administrator and the account has no address ' +
            'at all. Otherwise it is left off and the row says ' +
            '`emailNotAttached`. Held by somebody else, it stays there and ' +
            'the row says `emailHeldElsewhere`.\n\n' +
            '**What a row gains:** a membership of the team when they have ' +
            'none, as a `member` and a spectator unless they are staff who ' +
            'guard nobody (an existing membership only gains the spectator ' +
            'flag, and its role is never raised); a guardian link, which ' +
            'may manage, to each `guardianOf` player of this team (an id ' +
            'naming no player here is counted in `guardiansMissing`); and, ' +
            'for staff, the `coach` and `scorekeeper` roles on the team. ' +
            'Roles are only ever added, and `admin` never is.\n\n' +
            '**Answers:** `result` is `created` (a new user), `matched` (an ' +
            'existing user who gained something here), `unchanged` or ' +
            '`error`. `counts.guardianLinks` is the links this call made, and ' +
            '`counts.staff` the adults who gained a role in it; posting the ' +
            'same body again answers both as 0.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['adults'],
                  properties: {
                    adults: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['externalId'],
                        properties: {
                          ...personNames,
                          email: { type: 'string', maxLength: 254 },
                          externalId: memberExternalId,
                          guardianOf: {
                            type: 'array',
                            maxItems: 50,
                            items: memberExternalId
                          },
                          staff: { type: 'boolean', default: false }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'One answer per row, in order, and the counts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: [
                            'index',
                            'result',
                            'joined',
                            'guardianLinks',
                            'guardiansMissing',
                            'rolesAdded'
                          ],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'matched', 'unchanged', 'error']
                            },
                            userId: { type: 'integer' },
                            joined: { type: 'boolean' },
                            guardianLinks: { type: 'integer' },
                            guardiansMissing: { type: 'integer' },
                            rolesAdded: {
                              type: 'array',
                              items: {
                                type: 'string',
                                enum: ['coach', 'scorekeeper']
                              }
                            },
                            emailHeldElsewhere: {
                              type: 'boolean',
                              enum: [true]
                            },
                            emailNotAttached: {
                              type: 'boolean',
                              enum: [true]
                            },
                            externalIdNotAttached: {
                              type: 'boolean',
                              enum: [true]
                            },
                            error: memberRowError
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          matched: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' },
                          guardianLinks: { type: 'integer' },
                          staff: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/logo': {
        put: {
          summary: "Store a team's logo",
          description:
            'Stores the team\u2019s logo, padded to a square so a wide ' +
            'badge keeps its shape and a transparent one stays transparent.' +
            '\n\n' +
            pictureRules,
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: pictureBody,
          responses: {
            200: pictureAnswer,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            413: errorResponse,
            415: errorResponse,
            503: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/avatar': {
        put: {
          summary: "Store a player's headshot",
          description:
            'Stores the headshot of a player of this team, cropped to a ' +
            'square. It is the person\u2019s own picture, so it shows on ' +
            'every team they are on. A user who is not a player of this ' +
            'team is 404. A headshot whose source is `upload` is replaced ' +
            'only by a site administrator\u2019s upload; anybody else\u2019s ' +
            'answers `stored: false, kept: upload`.\n\n' +
            pictureRules,
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: pictureBody,
          responses: {
            200: pictureAnswer,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            413: errorResponse,
            415: errorResponse,
            503: errorResponse
          }
        }
      },
      '/games/{gameId}': {
        get: {
          summary: 'One game and its videos',
          description:
            '`fenceDistanceFt` is the fence the game is played to, in feet: ' +
            "the game's own, else its season's, else that season's " +
            "league's, else 200. A game with plays keeps the fence it had " +
            'when they began. `canScore` is whether the caller may post its ' +
            'plays: a scorekeeper of either team, which every admin of it ' +
            'is. `canDj` is whether the caller may DJ it: a songkeeper of ' +
            'either team, which every admin of it is. `scoreboard` is `{ open, mayOverride }`: ' +
            "whether the game's scoreboard is open, and whether the caller " +
            'runs the game and so may override it; null when the ' +
            'scoreboard store cannot be asked.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: { description: 'The game, its score and its videos' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/field': {
        put: {
          summary: "Set or clear one game's fence distance",
          description:
            'Whole feet, 1 to 600, from home plate to the fence, which ' +
            "sizes the ball's `totalDistance` and `coordinates` on the " +
            "game's plays. `null` clears the game's own, so its season's, " +
            "its league's or 200 feet applies. The fence is fixed once the " +
            'game has plays, whatever its status: the post that stores its ' +
            "first keeps the fence they were sized by (the post's " +
            '`fenceDistanceFt`, else the one the game resolves to then), ' +
            'whatever its season or league later sets, and this answers 409 ' +
            'while the game has plays. **Who may call:** ' +
            'a site admin, an admin of either team (an admin `scope_roles` ' +
            "team row, or its owner or manager), or an admin of the game's season " +
            'or its league. Anybody else who can see the game gets 403; a ' +
            'game the caller cannot see, or that does not exist, 404.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: fenceDistanceBody
              }
            }
          },
          responses: {
            200: {
              description:
                'What the game holds now, and the fence it is played to',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'gameId',
                      'fenceDistanceFt',
                      'resolvedFenceDistanceFt'
                    ],
                    properties: {
                      gameId: { type: 'string' },
                      fenceDistanceFt,
                      resolvedFenceDistanceFt: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 600
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/games/{gameId}/events': {
        post: {
          summary: "Replace a game's plays",
          description:
            'One body is the whole set. A play is replaced when its ' +
            '`about.atBatIndex` is already stored, and a stored index that is ' +
            'not in the body is deleted, including a legacy line-score-only ' +
            '`final_score` play, at index 9999 or, in a game with no other ' +
            'plays, at index 0. `source.system` names the sender: ' +
            '`teamstation`, `manual`, or an outside system spelled as an ' +
            "external id's system is, and a post with no `source` or no " +
            '`source.system` counts as an outside one. `teamstation` sets ' +
            '`scoringOwner`. An outside post is stored as `external`, is ' +
            'rejected once that owner is set, and its ' +
            "plays' `result.description` and `playEvents[].description` are " +
            "not stored. A post whose plays carry both teams' scores sets " +
            'the game `final`, and a final game refuses every later post with ' +
            '409, so a game is posted once it is over. Otherwise a ' +
            '`scheduled` game with plays becomes `inProgress`, and any other ' +
            'status, `cancelled` included, is kept. A post that leaves the ' +
            "The post that stores a game's first plays, whatever its status, " +
            'fixes its fence at the `fenceDistanceFt` it gives, else the one ' +
            'the game resolves to then, so a later season or league change ' +
            'never resizes its plays. ' +
            'The stats builder counts batting and pitching lines from these ' +
            'plays. Every counted play needs `about.inning`, ' +
            '`about.halfInning`, `matchup.pitcher`, `count.outs` and ' +
            '`runners[]`. A plate appearance also needs `matchup.batter` and ' +
            "the batter's own runner entry (`movement.start` null, " +
            '`details.runner` naming the batter). Every runner entry with a ' +
            '`movement` needs `details.runner`, `details.eventType`, and ' +
            '`movement.end` (or null when `movement.isOut` is true). A ' +
            'scoring entry also needs `details.responsiblePitcher`, ' +
            '`details.earned` and `details.rbi`. A player object may omit ' +
            '`id` (an unmapped opponent); a present `id` must name a ' +
            'TeamStation user. When the last play carries ' +
            '`result.awayScore` and `result.homeScore`, the runs from ' +
            "the 'score' runner entries must equal that score. A play that " +
            'lacks a required field is still stored: the builder marks the ' +
            'game `incomplete` with the reason and leaves any earlier ' +
            '`game_player_stats` rows untouched. **Who may call:** a ' +
            'scorekeeper of either team, set on the team, its season or its ' +
            'league, which every admin of them is, and a site admin. Anybody ' +
            'else who can see the game gets 403.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['plays'],
                  properties: {
                    plays: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/GumboPlay' }
                    },
                    source: {
                      type: 'object',
                      properties: {
                        system: {
                          type: 'string',
                          pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                        }
                      }
                    },
                    mode: {
                      type: 'string',
                      enum: ['replace', 'live'],
                      description:
                        '`replace`, the default, is a finished game arriving ' +
                        'whole. `live` is a game being scored: the plays sent ' +
                        'are written in place and only the indexes in ' +
                        '`remove` are deleted.'
                    },
                    remove: {
                      type: 'array',
                      items: { type: 'integer' },
                      description: 'On a live post: the indexes to delete'
                    },
                    currentPlay: {
                      oneOf: [
                        { $ref: '#/components/schemas/GumboCurrentPlay' },
                        { type: 'null' }
                      ],
                      description:
                        'On a live post: the at-bat in progress, or null ' +
                        'when there is none. Left out, the stored one stays.'
                    },
                    fenceDistanceFt: {
                      type: 'integer',
                      description:
                        "Feet to the fence the plays' distances were sized " +
                        "by: the game's `gameData.venue.fieldInfo.center`, " +
                        'which the plays do not carry. The post that stores ' +
                        "a game's first plays fixes its fence at this one. " +
                        'Anything but whole feet from 1 to 600 is ignored, ' +
                        "and the game's resolved fence is fixed instead."
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The stored plays, in atBatIndex order',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['plays'],
                    properties: {
                      plays: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['id', 'gameId', 'gumbo'],
                          properties: {
                            id: { type: 'string' },
                            gameId: { type: 'string' },
                            gumbo: { $ref: '#/components/schemas/GumboPlay' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        },
        get: {
          summary: "A game's plays",
          description: 'The stored plays in `atBatIndex` order.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                '{ plays: [{ id, gameId, gumbo }], currentPlay }: `gumbo` is ' +
                'a `GumboPlay`, `currentPlay` a `GumboCurrentPlay` or null',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['plays', 'currentPlay'],
                    properties: {
                      plays: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['id', 'gameId', 'gumbo'],
                          properties: {
                            id: { type: 'string' },
                            gameId: { type: 'string' },
                            gumbo: { $ref: '#/components/schemas/GumboPlay' }
                          }
                        }
                      },
                      currentPlay: {
                        oneOf: [
                          { $ref: '#/components/schemas/GumboCurrentPlay' },
                          { type: 'null' }
                        ]
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/default-lineup': {
        get: {
          summary: "A team's default lineup",
          description:
            'The starting lineup of the last game scored in TeamStation that ' +
            'began with a different one, the game it came from and when it ' +
            'was taken. The first live post after which a game has begun ' +
            "takes each side's starting lineup as its team's default, unless " +
            'the default already has the same order and fielders; undone ' +
            'back to before its first pitch, the game takes the lineup it ' +
            'begins with next. Substitutions, replace posts and outside ' +
            'posts never change it. The scoring screen starts a new game ' +
            'from it. Needs somebody who can see the team; 404 for anybody ' +
            'else.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: {
              description: 'The default, or all three null',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DefaultLineup' }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/lineups': {
        get: {
          summary: "Both sides' lineups in a game",
          description:
            'Read from the stored plays and the at-bat in progress: the ' +
            'lineup each side began with, every substitution the stored ' +
            'Gumbo announces, in game order, and the lineup as it stands. A ' +
            'game TeamStation did not score has only the substitutions its ' +
            'plays carry. Needs somebody who can see the game; 404 for ' +
            'anybody else.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: '{ away, home }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['away', 'home'],
                    properties: {
                      away: { $ref: '#/components/schemas/SideLineups' },
                      home: { $ref: '#/components/schemas/SideLineups' }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/dj': {
        get: {
          summary: "Both sides' batters and walk-up songs, for DJ Game",
          description:
            "Each side's batters in order, with each one's walk-up song on " +
            "that team (a placeholder has none). The order is the game's " +
            'own current lineup once TeamStation has a record of it, the ' +
            "team's default before that, and otherwise the team's players " +
            'by jersey number, then name. `canEditWalkUp` is whether the ' +
            "caller keeps that team's songs. `atBat` is the plate appearance " +
            'in progress: `side` is `away` in the top of an inning and `home` ' +
            'in the bottom, and `userId` is the batter, or null for a guest. ' +
            '`atBat` is null when no plate appearance is in progress. Needs ' +
            'somebody who can see the game; 404 for anybody else.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: '{ away, home }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['away', 'home', 'atBat'],
                    properties: {
                      away: { $ref: '#/components/schemas/DjSide' },
                      home: { $ref: '#/components/schemas/DjSide' },
                      atBat: {
                        description:
                          'The plate appearance in progress, or null.',
                        oneOf: [
                          {
                            type: 'object',
                            required: ['side', 'userId'],
                            properties: {
                              side: { enum: ['away', 'home'] },
                              userId: {
                                oneOf: [{ type: 'integer' }, { type: 'null' }]
                              }
                            }
                          },
                          { type: 'null' }
                        ]
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/halves': {
        get: {
          summary: 'One outcome per half inning',
          description:
            '`inning`, `half`, `awayScore`, `homeScore`, `outs`, and `runs`. ' +
            'Read off the stored plays. A play with no half is omitted.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: { description: '{ halves: [ ... ] }' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/logs': {
        post: {
          summary: "A client's own log lines, written to the server's log",
          description:
            'For the TeamStation app, or any client that runs ' +
            "away from the server. Each line is written to the server's log " +
            'tagged `[client <source>]` with `run`, `build` and the signed-in ' +
            'user, if any. No session is needed. At most 200 lines per post; ' +
            'each line is cut at 2000 characters. Nothing is stored.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['source', 'lines'],
                  properties: {
                    source: { type: 'string' },
                    run: { type: 'string' },
                    build: { type: 'string' },
                    lines: {
                      type: 'array',
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['at', 'level', 'text'],
                        properties: {
                          at: { type: 'string' },
                          level: {
                            type: 'string',
                            enum: ['debug', 'info', 'warn', 'error']
                          },
                          text: { type: 'string' },
                          data: {}
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            204: { description: 'Written' },
            400: { description: 'Malformed, or more than 200 lines' }
          }
        }
      },
      '/games/{gameId}/box-score': {
        get: {
          summary: "A game's batting and pitching lines",
          description:
            'Added up from the stored stat lines, one row per player per ' +
            "game. The stats builder writes them whenever the game's plays " +
            'change. `stats` is where that build stands: `none` when nothing ' +
            'has asked for this game yet, `pending` while a build is owed, ' +
            '`built` when the lines match the plays, `incomplete` when a ' +
            'required Gumbo field is missing (with `detail` naming the play ' +
            'and field), or `failed` after a build threw. A game with no ' +
            'lines yet has empty `batting` and `pitching`.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                'A line per batter and pitcher, with rates, and `stats` for ' +
                "the builder's status"
            },
            404: errorResponse
          }
        }
      },
      '/videos/{videoId}/highlights': {
        get: {
          summary: 'Where to seek to in this video for each play',
          description:
            'Highlights are never stored: they are worked out from the plays ' +
            'and the current settings on every read, so a corrected lag or a ' +
            're-synced video fixes them all at once. A highlight is a ' +
            'timestamp into the full video, never a separate clip. When the ' +
            "game's plays did not add up to its imported line score, " +
            '`withheld` is `scoreMismatch` and the list is empty.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'videoId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: 'Highlights in game order, oldest first' },
            404: errorResponse
          }
        }
      },
      '/players/{userId}/stats': {
        get: {
          summary: "A player's batting and pitching, narrowed as asked",
          description:
            'Every figure is a sum of that player\u2019s per-game stat lines, ' +
            'so a total here and a line in a box score are the same rows ' +
            'added up differently. Unfiltered is a career. The answer carries ' +
            'the seasons, teams and years there are to choose from, which is ' +
            'what the filter on the page offers. `rates.era` is earned runs ' +
            "per game, a game being the season's or league's ERA innings " +
            '(six unless set), and is absent for a pitcher with no outs.',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games in this season'
            },
            {
              name: 'teamId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games played for this team'
            },
            {
              name: 'year',
              in: 'query',
              schema: { type: 'integer' },
              description: 'Only games played in this calendar year'
            }
          ],
          responses: {
            200: {
              description: 'The totals, and what they can be narrowed to'
            },
            404: errorResponse
          }
        }
      },
      '/players/{userId}/plays': {
        get: {
          summary: 'The plays a figure was worked out from',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only this season'
            },
            {
              name: 'eventType',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only this kind of play, e.g. `single`'
            },
            {
              name: 'role',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'batter',
                  'pitcher',
                  'runner',
                  'scorer',
                  'fielder',
                  'catcher'
                ]
              },
              description: 'Only plays where they had this part in it'
            }
          ],
          responses: {
            200: { description: 'The plays, newest game first' },
            401: errorResponse
          }
        }
      },
      '/seasons': {
        get: {
          summary: 'The seasons you may watch',
          description:
            'Each season carries `startsOn` and `endsOn` (`YYYY-MM-DD`, or ' +
            'null), the days a game with no `seasonId` is placed by. ' +
            '`team` may be repeated, and narrows the list to the seasons ' +
            'those teams play in. Asked that way, a season the caller may ' +
            'schedule games in counts as one they may see. Leaving it out ' +
            'lists every season the caller may watch.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'team',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: 'Teams whose seasons to list'
            }
          ],
          responses: {
            200: {
              description:
                'Being in a season grants every team in it; being on a team ' +
                'is separate and stronger'
            },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/teams': {
        get: {
          summary: "A season's teams",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: 'Every team playing in it' },
            404: errorResponse
          }
        }
      },
      '/users': {
        get: {
          summary: 'Who people are here, by the ids another service has',
          description:
            'A play names people by TeamStation user id alone, so a sender ' +
            'asks this with the ids it holds first. Each answer is ' +
            '`{ userId, externalIds }`: a person, and which of the asked ids ' +
            'are theirs. A merged row answers as the person it was merged ' +
            'into. Only people you could see the page of are answered. ' +
            '`externalId` is required and may be given more than once; an ' +
            'empty one is refused.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'externalId',
              in: 'query',
              required: true,
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: "Another service's ids for the people"
            }
          ],
          responses: {
            200: {
              description: 'In user id order; empty when nobody matches'
            },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/teams/{teamId}/roster': {
        get: {
          summary: "A team's players, coaches and followers",
          description:
            'Names are a first name and a last initial, for every caller; ' +
            'the whole name is only on `GET /players/{userId}/name`. ' +
            '`walkUpSong` is the WalkUpSong the person has ' +
            'on this team, or null. Whether the caller may change the songs ' +
            'is `GET /me/roles`: `songkeeper` or `admin` on the team.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'The roster, coaches first' },
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/settings': {
        put: {
          summary: "Set a player's jersey, positions, bats and throws",
          description:
            'For a coach of the team — the flag set on the team, its season ' +
            'or its league — an admin of any of those, or a site admin. ' +
            'Anybody else, and a user who is not a player on the team, gets ' +
            '404. Send only the fields to change; a body with none is 400. ' +
            "`jersey` and `positions` are the player's place on this team. " +
            "`bats` and `throws` are the player's own and read the same on " +
            'every team; setting either marks them set by hand, so a ' +
            'roster import no longer overwrites them. Audited. ' +
            "Answers with the player's roster entry as it now reads.",
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  properties: {
                    jersey: {
                      type: 'string',
                      nullable: true,
                      maxLength: JERSEY_MAX_LENGTH,
                      description: 'Trimmed; empty or null is no number.'
                    },
                    positions: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: [...PLAYER_POSITIONS]
                      },
                      description:
                        'Replaces every position; stored once each, in this order.'
                    },
                    bats: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right', 'switch']
                    },
                    throws: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right']
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                "The player's roster entry, as GET /teams/{teamId}/roster lists it"
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/walk-up-song': {
        put: {
          summary: "Set a player's walk-up song on a team",
          description:
            'For a songkeeper of the team — the flag set on the team, its ' +
            'season or its league — an admin of any of those, or a site ' +
            'admin. Anybody else, and a user who is not a player on the ' +
            'team, gets 404; a bad body is 400. Replaces any song the player ' +
            'had on the team. Audited, and announced on the game socket as a ' +
            '`walkUpSong` change to every subscribed game the team plays in. ' +
            'Answers with the song as stored.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WalkUpSong' }
              }
            }
          },
          responses: {
            200: {
              description: 'The song as stored',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalkUpSong' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        delete: {
          summary: "Remove a player's walk-up song on a team",
          description:
            'The same rights as setting one. Removing a song the player does ' +
            'not have is also 204. Audited, and a removal is announced on the ' +
            'game socket with `song: null`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          responses: {
            204: { description: 'The player has no song on the team' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/stats': {
        get: {
          summary: "A team's batting or pitching",
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            {
              name: 'kind',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['batting', 'pitching'],
                default: 'batting'
              }
            },
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'One season, or every season when unset'
            }
          ],
          responses: {
            200: { description: 'A row per player' },
            404: errorResponse
          }
        }
      },
      '/director/events/{gameId}/stream': {
        get: {
          summary: 'What this Director\u2019s camera on a game is doing',
          description:
            'Asked when a publish fails: the ingest writes why on the row, ' +
            'and that sentence beats the socket\u2019s, which can only say ' +
            'that a connection closed.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: 'The state of this account\u2019s camera',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      gameId: { type: 'string' },
                      state: { type: 'string' },
                      lastError: { type: ['string', 'null'] }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/invites': {
        get: {
          summary: 'The invite codes for one league, season or team',
          description:
            'Answers `canInvite: false` with an empty list for somebody who ' +
            'can see the page but does not administer it, so the panel ' +
            'simply does not draw itself.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'scopeType',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['league', 'season', 'team'] }
            },
            {
              name: 'scopeId',
              in: 'query',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'What may be done here, and what is already made',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['canInvite', 'invites'],
                    properties: {
                      canInvite: { type: 'boolean' },
                      invites: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Invite' }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse
          }
        },
        post: {
          summary: 'Make an invite code',
          description:
            'Administrators only, of the very league, season or team named ' +
            '— and rights inherit downwards, so a league administrator may ' +
            'invite to any of its teams. A code of your own is allowed; ' +
            'left out, one is generated.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['scopeType', 'scopeId'],
                  properties: {
                    scopeType: {
                      type: 'string',
                      enum: ['league', 'season', 'team']
                    },
                    scopeId: { type: 'string' },
                    code: { type: 'string' },
                    label: { type: 'string' },
                    maxUses: { type: 'integer', minimum: 1 },
                    expiresAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'The invite, with the address to hand out',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Invite' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/invites/{id}': {
        delete: {
          summary: 'Stop an invite code',
          description:
            'The row stays, so who came in through it can still be read.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            204: { description: 'Stopped' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/join/{code}': {
        get: {
          summary: 'What an invite code is worth',
          description:
            'Answered whether or not anybody is signed in: somebody with no ' +
            'account has to be told what they are being invited to before ' +
            'they hand over an address. An unknown code answers 404.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'The invitation',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InviteInfo' }
                }
              }
            },
            404: errorResponse
          }
        }
      },
      '/join/{code}/redeem': {
        post: {
          summary: 'Take up an invitation as whoever is signed in',
          description:
            '`granted` is false when they already had the access, which is ' +
            'not a failure and does not cost the invite a use.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'What they were let into',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['granted', 'scope'],
                    properties: {
                      granted: { type: 'boolean' },
                      scope: {
                        type: 'object',
                        properties: {
                          kind: {
                            type: 'string',
                            enum: ['league', 'season', 'team']
                          },
                          id: { type: 'string' },
                          name: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/join/{code}/email-code': {
        post: {
          summary: 'Ask for a sign-in code that carries this invitation',
          description:
            'The way somebody with no account comes in through a link. The ' +
            'account is made when that code is typed or its link opened — ' +
            'never here — so an address nobody can read gets nowhere. The ' +
            'answer is the same whether or not the address already has an ' +
            'account.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string' },
                    displayName: {
                      type: 'string',
                      description: 'What an account made by this will be called'
                    },
                    origin: {
                      type: 'string',
                      enum: ['web', 'ios', 'android']
                    },
                    next: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            202: {
              description: 'The sign-in this client is now waiting on',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sent', 'requestId', 'clientSecret'],
                    properties: {
                      sent: { type: 'boolean' },
                      requestId: { type: 'string' },
                      clientSecret: {
                        type: 'string',
                        description:
                          'Held by this client, so a link opened elsewhere ' +
                          'can finish the sign-in it is waiting on'
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            404: errorResponse,
            429: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}': {
        get: {
          summary: 'Who can see this, and how',
          description:
            'The page behind the gear on a team, season or league card. ' +
            '`tree` names the levels around this one, so a tick in the ' +
            'people table can say which season or league it stands for. ' +
            'Answers 404 to anybody who does not administer the scope.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          responses: {
            200: {
              description: 'The people, the pending invitations and the links',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ManagePage' }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/field': {
        put: {
          summary: "Set or clear a league's or season's fence distance",
          description:
            'Whole feet, 1 to 600, from home plate to the fence on this ' +
            "league's or season's fields. A game takes its own, else its " +
            "season's, else its league's, else 200. `null` clears this " +
            "level's. A team has no field of its own: `team` answers 400. " +
            'Answers 404 to anybody who does not administer the scope.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: fenceDistanceBody
              }
            }
          },
          responses: {
            200: {
              description: 'What the level holds now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['scopeType', 'scopeId', 'fenceDistanceFt'],
                    properties: {
                      scopeType: {
                        type: 'string',
                        enum: ['league', 'season']
                      },
                      scopeId: { type: 'string' },
                      fenceDistanceFt
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people': {
        post: {
          summary: 'Add one person by address',
          description:
            'An address that already has an account is given the access at ' +
            'once. Any other is sent an invitation made out to it, good for ' +
            'one use; the account is still made by the sign-in that follows.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Added, or invited',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['added'],
                    properties: {
                      added: { type: 'boolean' },
                      person: {
                        type: 'object',
                        properties: {
                          userId: { type: 'string' },
                          displayName: { type: 'string' },
                          email: { type: 'string' }
                        }
                      },
                      invited: {
                        $ref: '#/components/schemas/PendingPerson'
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}': {
        delete: {
          summary: 'Take away what this level grants',
          description:
            'Only this level. A team administrator cannot remove the season ' +
            'membership that also lets somebody watch, which is not theirs ' +
            'and would drop that person from every other team in it.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          responses: {
            200: {
              description: 'Whether there was anything here to remove',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['removed'],
                    properties: { removed: { type: 'boolean' } }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}/roles': {
        put: {
          summary: 'Set everything somebody may do at this level',
          description:
            'Replaces their roles on this one level: `admin`, and any of ' +
            'the flags `coach`, `scorekeeper`, `songkeeper` and ' +
            '`videographer`. A role set here reaches everything inside ' +
            'this level. Only at the level named: a team page sets team ' +
            'roles and nothing wider. It adds them to the level as well, so ' +
            'they can see what they hold a role on. Only an admin of this ' +
            'level or one above it may call; anybody else gets 404. Nobody ' +
            'may clear their own `admin` here.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['admin', 'flags'],
                  properties: {
                    admin: { type: 'boolean' },
                    flags: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/RoleFlag' }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The roles they hold on this level now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'roles'],
                    properties: {
                      userId: { type: 'integer' },
                      roles: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Role' }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}/role': {
        put: {
          summary: 'Make somebody an administrator of this level, or not',
          description:
            'The route from before the role flags, kept for older apps. ' +
            '`admin` makes them this level\u2019s administrator and `member` ' +
            'takes that away; either leaves their flags as they were, and ' +
            'leaves them able to watch. Only at the level named. Nobody may ' +
            'demote themselves.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['role'],
                  properties: {
                    role: { type: 'string', enum: ['admin', 'member'] }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'What they are now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'role'],
                    properties: {
                      userId: { type: 'string' },
                      role: { type: 'string', enum: ['admin', 'member'] }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/live': {
        get: {
          summary: 'The games being played right now that you may watch',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description:
                'Newest first, and empty on every day when nothing is on'
            },
            401: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams': {
        get: {
          summary: 'Every camera pointed at this game',
          description:
            'Split into `mine` and `others`. A key is a person\u2019s: their own ' +
            'cameras come back whole enough to act on, and everybody ' +
            'else\u2019s are named — whose, what it is called, what it is doing ' +
            '— and never carry a key.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: 'Mine, theirs, and how many more I may add',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            404: errorResponse
          }
        },
        post: {
          summary: 'Another camera of my own on this game',
          description:
            'Up to four per person per game. The slot is the lowest I do not ' +
            'already hold, so ending one and asking again gives that number ' +
            'back rather than counting upwards.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { label: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Created, with the URL and its key',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            200: { description: 'The one that won a race for the same slot' },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/videos/{videoId}': {
        delete: {
          summary: 'Delete a recording, its files, and its copy in the Space',
          description:
            'For whoever runs the game, and for the person whose camera made ' +
            'it. Refused while something is still streaming into it, and ' +
            'refused for a legacy recording, which lives in a tree this ' +
            'server reads and does not own.',
          security: [{ bearer: [] }],
          parameters: [videoIdParam],
          responses: {
            200: {
              description: 'What went, and how much of it left the Space',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      removedFromSpace: { type: 'integer' }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}': {
        delete: {
          summary: 'Take one of my cameras off this game',
          description:
            'Not the same as ending it. Ending stops a camera; this removes ' +
            'it and gives its number back. Mine only, and refused while it ' +
            'is streaming. An empty recording goes with it; one that holds ' +
            'video stays, and is deleted on its own.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: {
              description: 'What is left pointed at this game',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        patch: {
          summary: 'Rename one of my cameras',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'The camera as it now stands' },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/reveal': {
        post: {
          summary: 'Show one of my URLs again, key and all',
          description:
            'Mine only — somebody else\u2019s key is answered 404, because it ' +
            'publishes video as them. Written to the audit log every time.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, with its URL' },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/rotate': {
        post: {
          summary: 'Replace one of my keys. The old one stops at once',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, with its new URL' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/end': {
        post: {
          summary: 'End one camera now',
          description:
            'Mine, or anybody\u2019s if I run the team: a stream on their game ' +
            'that should not be there is theirs to stop. Closes the window ' +
            'rather than the playlist — only the ingest may touch a file its ' +
            'own ffmpeg is writing, and it notices within the second.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, ending' },
            404: errorResponse
          }
        }
      },
      '/events': {
        get: {
          summary: 'Games, filtered by the query string',
          description:
            'The one list. `scope=visible` (the default) is every game you ' +
            'may see: your teams, and every game of a season opened to you. ' +
            'A site administrator sees every game. `scope=run` is every game ' +
            'you may score — owner, manager, or an admin of the team, its ' +
            'season or its league — and omits cancelled games. Somebody who ' +
            'runs nothing gets an empty array. `scope=film` is every game ' +
            'you may film — a videographer of the team, its season or its ' +
            'league, which every admin of them is — and omits cancelled ' +
            'games. Somebody who films nothing gets an empty array.\n\n' +
            '`season` may be repeated. On `scope=visible`, a season you ' +
            'cannot see is 404. `when` is `all` (newest first), `upcoming` ' +
            '(no score and still ahead, soonest first), `past` (the rest), ' +
            '`future` (still ahead, scored or not, soonest first), ' +
            '`finished` (started before the look-back, latest first), or ' +
            '`recent` (started inside the look-back, up to now, latest ' +
            'first). `lookbackHours` is how far `finished` (default 2), ' +
            '`recent` (default 3), and `when=all` reach; on `when=all` the ' +
            'list runs forward from that instant. `since` and `until` are ' +
            'instants, `until` exclusive. `order` is `asc` or `desc`. ' +
            '`limit` is a whole number of at least 1; omit it for no cap. ' +
            '`externalId` may be repeated. `played=1` keeps games that have ' +
            'a score. `scoreboard=open` keeps games whose scoreboard is ' +
            'still open, and answers 503 while that store is away.\n\n' +
            'Each row is a schedule game plus `gameId`, both teams\u2019 logo ' +
            'URLs, `liveState`, and `opponentFixed`: true when a schedule ' +
            "can never change the game's opponent, because it was scored in " +
            'TeamStation (scored by its scorer, a play carrying its ' +
            '`teamStation` record, or an at-bat under way) or neither team ' +
            'is an external one.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'scope',
              in: 'query',
              schema: { type: 'string', enum: ['visible', 'run', 'film'] }
            },
            {
              name: 'season',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true
            },
            {
              name: 'when',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'all',
                  'upcoming',
                  'past',
                  'future',
                  'finished',
                  'recent'
                ]
              }
            },
            {
              name: 'lookbackHours',
              in: 'query',
              schema: { type: 'number' }
            },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'string', format: 'date-time' }
            },
            {
              name: 'until',
              in: 'query',
              schema: { type: 'string', format: 'date-time' }
            },
            {
              name: 'order',
              in: 'query',
              schema: { type: 'string', enum: ['asc', 'desc'] }
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1 }
            },
            {
              name: 'externalId',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true
            },
            {
              name: 'played',
              in: 'query',
              schema: { type: 'string', enum: ['1', 'true'] }
            },
            {
              name: 'scoreboard',
              in: 'query',
              schema: { type: 'string', enum: ['open'] }
            }
          ],
          responses: {
            200: { description: 'The games that match' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}': {
        get: {
          summary: "A game's scoreboard, as it is drawn",
          description:
            'No sign-in. `{ state }`, the board with every override applied, ' +
            "while the scoreboard is open: from the game's creation until two " +
            'hours after its start, and after that until two hours after the ' +
            'last write, never later than three days after the start. 404 ' +
            'for a cancelled or unknown game or a closed scoreboard, and 503 ' +
            'while the scoreboard store is unreachable.',
          parameters: [gameIdParam],
          responses: {
            200: { description: '`{ state }`' },
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}/dashboard': {
        get: {
          summary: "The override dashboard's state, or its socket",
          description:
            'As JSON: `{ automated, overrides, final, gameAt, watcherAt }`, ' +
            'where `gameAt` and `watcherAt` are when (epoch ms) each ' +
            'automated source last reported a contested field. ' +
            'With `Upgrade: websocket` it is the dashboard socket: it sends ' +
            "`{ type: 'state', automated, overrides, final, gameAt, " +
            'watcherAt }` on open and after every change, and takes ' +
            "`{ type: 'overrides', data }`, stored whole, or " +
            "`{ type: 'reset' }`, which clears every override and TS " +
            "Watcher's stored state, so the board shows the game's own " +
            'scoring. An unreadable message is answered with ' +
            '`{ error }` and the socket stays open. **Who may call:** a site ' +
            'admin or an admin of either team; anybody else gets 404, or ' +
            'close 4403 on the socket. Socket close codes: 4401 not signed ' +
            'in, 4403 may not override this game, 4404 no such game or its ' +
            'scoreboard is closed, 1011 the store is unreachable.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            101: { description: 'The dashboard socket' },
            200: { description: 'The dashboard state' },
            401: errorResponse,
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}/socket': {
        get: {
          summary: "A game's scoreboard as a WebSocket",
          description:
            'No sign-in. Sends the board as it is drawn, `ScoreState` JSON, ' +
            'on open and after every change from any source. Inbound ' +
            'messages are ignored. Closes with 4404 when there is no such ' +
            'game or its scoreboard is closed, and 1011 while the store is ' +
            'unreachable.',
          parameters: [gameIdParam],
          responses: { 101: { description: 'The viewer socket' } }
        }
      },
      '/scoreboard/{gameId}/publish': {
        get: {
          summary: "Publish to a game's scoreboard over a WebSocket",
          description:
            "TS Watcher's socket. Each message is a bare partial " +
            '`ScoreState` JSON object, merged into what Watcher has sent ' +
            'before. Team names are ignored: they come from the game. An ' +
            'unreadable message is answered with `{ error }` and the socket ' +
            'stays open. **Who may call:** a site admin or an admin of ' +
            'either team, by bearer token or session cookie. Close codes: ' +
            '4401 not signed in, 4403 may not publish this game, 4404 no ' +
            'such game or its scoreboard is closed, 1011 the store is ' +
            'unreachable.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: { 101: { description: 'The publisher socket' } }
        }
      },
      '/director/events/{gameId}/claim': {
        post: {
          summary: 'Take a game, and get the URL to publish it to',
          description:
            'For a videographer of either team, which every admin of it ' +
            'is. Anybody else gets 404.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                'The URL with its key, which the operator never sees or types'
            },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/auth/link/verify': {
        post: {
          summary: 'Spend the link from the e-mail',
          description:
            'Never reached by a bare page load: the address opens the app, ' +
            'which asks for this once it is running, so a mail scanner that ' +
            'follows links without running scripts cannot spend it.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: { token: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'A session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/request/claim': {
        post: {
          summary: 'What the client that asked for the sign-in is waiting on',
          description:
            'Tap the link on a laptop while TS Director is still waiting, and ' +
            'this is how the iPad finds out: it polls with a secret only it ' +
            'holds. `deviceName` asks for a session that lasts a season and ' +
            'is named, which is what a Director wants and a browser does not.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['requestId', 'clientSecret'],
                  properties: {
                    requestId: { type: 'string' },
                    clientSecret: { type: 'string' },
                    deviceName: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'A session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            202: { description: 'Still waiting, which is the ordinary answer' },
            401: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/standings': {
        get: {
          summary: "A season's table",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description:
                'Best record first, run differential as the tie-break'
            },
            404: errorResponse
          }
        }
      }
    }
  }
}
