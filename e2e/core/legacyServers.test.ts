import { expect } from 'chai'

import { LOCAL_REDIS, stackServers } from './legacyServers'

describe('stackServers', function () {
  it('uses this machine’s servers when nothing is named', function () {
    expect(stackServers('AppDb_x', {})).deep.equals({
      clusterArgs: ['-h', 'localhost', '-p', '5433'],
      databaseUrl: 'postgres://localhost:5433/AppDb_x',
      redisUrl: LOCAL_REDIS
    })
    expect(
      stackServers('AppDb_x', {
        TS_TEST_DATABASE_URL: '',
        TS_TEST_REDIS_URL: ''
      }).redisUrl
    ).equals(LOCAL_REDIS)
  })

  it('reaches the cluster and store the environment names, with their user and password', function () {
    const servers = stackServers('AppDb_x', {
      TS_TEST_DATABASE_URL:
        'postgres://tester:s%40cret@db.example:6543/postgres',
      TS_TEST_REDIS_URL: 'redis://store.example:6380/15'
    })
    expect(servers).deep.equals({
      clusterArgs: ['-h', 'db.example', '-p', '6543', '-U', 'tester'],
      password: 's@cret',
      databaseUrl: 'postgres://tester:s%40cret@db.example:6543/AppDb_x',
      redisUrl: 'redis://store.example:6380/15'
    })
  })

  it('takes Postgres’s own port when the URL names none', function () {
    expect(
      stackServers('AppDb_x', {
        TS_TEST_DATABASE_URL: 'postgres://db.example/p'
      }).clusterArgs
    ).deep.equals(['-h', 'db.example', '-p', '5432'])
  })
})
