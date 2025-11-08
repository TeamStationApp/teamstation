import { asObject, asOptional, asString } from 'cleaners'

import clientConfigJson from '../../clientConfig.json'

const asClientConfig = asObject({
  apiServer: asOptional(asString, 'ws://localhost:8008')
}).withRest

export type ClientConfig = ReturnType<typeof asClientConfig>
export const clientConfig = asClientConfig(clientConfigJson)
