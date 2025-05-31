import { parseBaseInputs } from './base-inputs.js'
import { ProvisionInputs } from './types.js'
import { getNumber, getStringArray, getGeneric, getString } from './helpers.js'

import { PROVISION_DEFAULT } from './defaults.js'
import { UsageClassType } from '@aws-sdk/client-ec2'

export function parseProvisionInputs(): ProvisionInputs {
  const baseInputs = parseBaseInputs()

  return {
    // universally required
    ...baseInputs,
    mode: 'provision',
    // mode-specific required and optional with defaults
    // .instance-count not required, use default instead
    instanceCount: getNumber('instance-count', false, PROVISION_DEFAULT),
    usageClass: getUsageClass(),
    allowedInstanceTypes: getStringArray(
      'allowed-instance-types',
      false,
      PROVISION_DEFAULT
    ),
    resourceClass: getString('resource-class', false, PROVISION_DEFAULT),
    maxRuntimeMin: getNumber('max-runtime-min', false, PROVISION_DEFAULT)
  }
}

export function getUsageClass(): UsageClassType {
  return getGeneric<UsageClassType>(
    'usage-class',
    (raw: string) => {
      if (raw !== 'spot' && raw !== 'on-demand') {
        throw new Error(
          `usage-class must be 'spot' or 'on-demand', got '${raw}'`
        )
      }
      return raw as UsageClassType
    },
    false,
    PROVISION_DEFAULT
  )
}
