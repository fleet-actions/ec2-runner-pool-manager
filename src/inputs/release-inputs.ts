import { parseBaseInputs } from './base-inputs.js'
import { ReleaseInputs } from './types.js'

export function parseReleaseInputs(): ReleaseInputs {
  const baseInputs = parseBaseInputs()

  // 🔍 There are no explicit release inputs. Labels/Instance ids will be inferred from DDB RunID
  const input: ReleaseInputs = {
    ...baseInputs,
    // override any base input attributes
    mode: 'release'
  }

  return input
}
