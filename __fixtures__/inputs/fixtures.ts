import { jest } from '@jest/globals'
import {
  REFRESH_DEFAULTS as REFRESH_DEFAULTS_ACTUAL,
  RESOURCE_CLASS_CONFIG_DEFAULT as RESOURCE_CLASS_CONFIG_DEFAULT_ACTUAL,
  PROVISION_DEFAULT as PROVISION_DEFAULTS_ACTUAL,
  UNSPECIFIED_MAX_RUNTIME_MINUTES as UNSPECIFIED_MAX_RUNTIME_MINUTES_ACTUAL
} from '../../src/inputs/defaults.js'

/**
 * Contains fixtures for all files in src/inputs
 */

export const inputs =
  jest.fn<typeof import('../../src/inputs/index.js').inputs>()

export const parseBaseInputs =
  jest.fn<typeof import('../../src/inputs/base-inputs.js').parseBaseInputs>()

export const REFRESH_DEFAULTS = REFRESH_DEFAULTS_ACTUAL
export const RESOURCE_CLASS_CONFIG_DEFAULT =
  RESOURCE_CLASS_CONFIG_DEFAULT_ACTUAL
export const PROVISION_DEFAULT = PROVISION_DEFAULTS_ACTUAL
export const UNSPECIFIED_MAX_RUNTIME_MINUTES =
  UNSPECIFIED_MAX_RUNTIME_MINUTES_ACTUAL
