import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  POSITION_CODES,
  STORED_EVENT_TYPES
} from '../common/gumbo/reference'

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

const sorted = (codes: ReadonlySet<string>): string[] => [...codes].sort()

/** A player a play names: his GameStation user id, or only a name. */
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
    "GameStation's extensions: `final_score` and `score_correction` (an " +
    'import), `gs_manual_placement` (a batter the scorer put ' +
    'on base by hand), `gs_batter_out` (a batter out on a play MLB has no ' +
    'code for) and `gs_batting_order` (a change of batting order). A post ' +
    'may still send `catcher_interference`, `placed_runner` or ' +
    '`manual_placement`; they are stored as `catcher_interf`, ' +
    '`runner_placed` and `gs_manual_placement`. It may also send the ' +
    "names older imports used, each stored as MLB's or " +
    "GameStation's code: `runner_out` as `other_out`, `batter_out` as " +
    '`field_out`, `catcher_s_interference` as `catcher_interf`, ' +
    '`fc_double_play` as `double_play`, `offensive_interference` as ' +
    '`batter_interference`, `batter_put_on_base` as `gs_manual_placement` ' +
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
      '`src2/common/gumbo/reference/`. `npm run validate-gumbo` checks every ' +
      'stored play against them. GameStation adds only the `gameStation` ' +
      'record, the `gs_` event types and `about.halfOuts`. A play another ' +
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
              'GameStation extension, written by the server on the last ' +
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
      gameStation: { $ref: '#/components/schemas/GameStationRecord' }
    }
  },
  GumboRunner: {
    type: 'object',
    description:
      'One movement of one runner, in the order they happened. A play ' +
      'GameStation scored carries every key; one another service posted, ' +
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
              "MLB's pitch codes (`api/v1/pitchCodes`). GameStation writes " +
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
          'GameStation measures nothing, so it writes no `coordinates` or ' +
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
          'its league says otherwise). GameStation writes no speed; a ' +
          'dictated angle, the untouched default, or one estimated from a ' +
          'trajectory alone stays in the `gameStation` record.',
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
          "`pitching_substitution` or `gs_batting_order`. As in MLB's feed, " +
          "a side's changes to its fielders from when it leaves the field " +
          'to its first pitch back in it are written as their net change at ' +
          'the start of the first play it fields. A pinch hitter is written ' +
          'at the start of the first play he bats in, and a pinch runner ' +
          'where he takes the base. A `gs_batting_order` names only players ' +
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
      'the `gameStation` record.',
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
      gameStation: { $ref: '#/components/schemas/GameStationRecord' }
    }
  },
  GameStationRecord: {
    type: 'object',
    description:
      'GameStation extension, on every play it scored and on the at-bat in ' +
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
      title: 'GameStation',
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
                'internal'
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
            pid: { type: 'integer' }
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
            adminOf: {
              type: 'array',
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
          summary: 'The teams this person belongs to',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Their teams, which may be an empty list' },
            401: errorResponse
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
            '**Who may call:** a site admin, an admin of the team (an ' +
            '`admin_roles` team row, or its owner or manager), or an admin of ' +
            "a season the team plays in or of that season's league. A plain " +
            'member, parent or spectator gets 403; a team the caller can ' +
            'neither see nor administer gets 404. A season or league admin ' +
            'may only schedule into a season they administer: a row into ' +
            'another season is `forbidden`.\n\n' +
            '**A row:** `opponent` (`{teamId}` or `{name}`, 1-120 characters) ' +
            'and `side` (`home` or `away`, the side this team plays on) are ' +
            'needed to create a game and ignored for a matched one. ' +
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
            'that system and id (of any kind) is matched: an `inProgress` or ' +
            '`final` game is left as it is; a `scheduled` or `cancelled` one ' +
            "takes the row's time, venue, status and fence distance, and " +
            'is `updated` when any of them changed. Teams, season and ' +
            'scores never change. Without a match, a game in the same season ' +
            'between the same two teams at the same time takes the id. ' +
            'Otherwise the row creates a game. A row without `externalId` ' +
            'always creates one. An opponent named by `name` is a team of the ' +
            'season with that name or coach, else an external team of that ' +
            'name, else a new external team.\n\n' +
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
                                properties: { teamId: { type: 'string' } }
                              },
                              {
                                type: 'object',
                                required: ['name'],
                                properties: {
                                  name: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 120
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
      '/games/{gameId}': {
        get: {
          summary: 'One game and its videos',
          description:
            '`fenceDistanceFt` is the fence the game is played to, in feet: ' +
            "the game's own, else its season's, else that season's " +
            "league's, else 200. A game with plays keeps the fence it had " +
            'when they began.',
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
            'a site admin, an admin of either team (an `admin_roles` team ' +
            "row, or its owner or manager), or an admin of the game's season " +
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
            '`gamestation`, `manual`, or an outside system spelled as an ' +
            "external id's system is, and a post with no `source` or no " +
            '`source.system` counts as an outside one. `gamestation` sets ' +
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
            'GameStation user. When the last play carries ' +
            '`result.awayScore` and `result.homeScore`, the runs from ' +
            "the 'score' runner entries must equal that score. A play that " +
            'lacks a required field is still stored: the builder marks the ' +
            'game `incomplete` with the reason and leaves any earlier ' +
            '`game_player_stats` rows untouched.',
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
            'For the GameStation app, or any client that runs ' +
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
          security: [{ bearer: [] }],
          responses: {
            200: {
              description:
                'Being in a season grants every team in it; being on a team ' +
                'is separate and stronger'
            },
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
      '/seasons/{seasonId}/games': {
        get: {
          summary: "A season's schedule",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            },
            {
              name: 'when',
              in: 'query',
              schema: { type: 'string', enum: ['past', 'upcoming'] },
              description: 'Which half of the schedule. Both, when unset'
            }
          ],
          responses: {
            200: { description: 'Newest first' },
            404: errorResponse
          }
        }
      },
      '/games': {
        get: {
          summary: 'Every game you can see',
          description:
            "Your teams' games, and every game of a season opened to you; a " +
            'site administrator sees every game. ' +
            "Each game as a season's schedule has it, newest first, in one " +
            'answer, with `externalIds`: the ids other services know it by, ' +
            'as its importers recorded them. `externalId` narrows it to the ' +
            'games known by that id, and may be given more than once; an ' +
            'empty one is refused.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'externalId',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: "Other services' ids for the games"
            }
          ],
          responses: {
            200: { description: 'Newest first; empty when there are none' },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/games/recent': {
        get: {
          summary: 'The newest played game anywhere you can see',
          description:
            'What the home screen leads with: the newest game with a score ' +
            'among those `GET /games` lists. Null when there is none.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'One game, or null' },
            401: errorResponse
          }
        }
      },
      '/users': {
        get: {
          summary: 'Who people are here, by the ids another service has',
          description:
            'A play names people by GameStation user id alone, so a sender ' +
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
            'Names are a first name and a last initial: a full name is not ' +
            'something this API hands out about a child.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'The roster, coaches first' },
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/stats': {
        get: {
          summary: "A team's batting",
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
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
      '/manage/{scopeType}/{scopeId}/people/{userId}/role': {
        put: {
          summary: 'Make somebody an administrator of this level, or a member',
          description:
            'Only at the level named: a team page makes team administrators ' +
            'and nothing wider. Either answer leaves them able to watch, ' +
            'because an administrator of something they cannot see is a ' +
            'state nobody asks for on purpose. Nobody may demote themselves.',
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
      '/director/events': {
        get: {
          summary: 'The next ten games of the teams you run',
          description:
            'Soonest first, reaching two hours backwards \u2014 a one o\u2019clock ' +
            'game somebody starts filming at ten past three is still the game ' +
            'they mean.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'At most ten, each with both teams\u2019 marks'
            },
            401: errorResponse
          }
        }
      },
      '/director/events/{gameId}/claim': {
        post: {
          summary: 'Take a game, and get the URL to publish it to',
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
            'which asks for this once it can tell a person is behind the ' +
            'request. A mail scanner follows links and runs no scripts.',
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
            'Tap the link on a laptop while GS Director is still waiting, and ' +
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
