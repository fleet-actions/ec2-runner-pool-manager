import { parseBaseInputs } from './base-inputs.js'
import { parseProvisionInputs } from './provision-inputs.js'
import { parseReleaseInputs } from './release-inputs.js'
import { parseRefreshInputs } from './refresh-inputs.js'
import { ActionInputs } from './types.js'

export function inputs(): ActionInputs {
  // allow error to bubble up
  const { mode } = parseBaseInputs()

  switch (mode) {
    case 'provision':
      return parseProvisionInputs()
    case 'release':
      return parseReleaseInputs()
    case 'refresh':
      return parseRefreshInputs()
    case 'cleanup': // NOTE: this is only for internal use
      return parseBaseInputs() as ActionInputs
    case 'echo': // NOTE: this is for testing only
      return parseBaseInputs() as ActionInputs
    default:
      throw new Error(`Invalid mode found in parsing: ${mode}`)
  }
}
