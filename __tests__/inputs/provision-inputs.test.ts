import { jest } from '@jest/globals'
import * as core from '../../__fixtures__/core.js'
import type { ProvisionInputs } from '../../src/inputs/types.js'

import {
  parseBaseInputs,
  PROVISION_DEFAULT
} from '../../__fixtures__/inputs/fixtures.js'

Object.entries({
  '@actions/core': core,
  '../../src/inputs/base-inputs': { parseBaseInputs },
  '../../src/inputs/defaults': {
    PROVISION_DEFAULT
  }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// actual import
const { parseProvisionInputs, getUsageClass } = await import(
  '../../src/inputs/provision-inputs.js'
)

describe('parseProvisionInputs', () => {
  // Define default valid inputs that we can override for specific tests
  const provisionSpecificInputs: Record<string, string> = {
    'instance-count': '3',
    'usage-class': 'spot',
    'allowed-instance-types': 'c5.large m5.large r*',
    'resource-constraint': 'exact',
    'max-runtime-min': '60',
    'resource-class': 'xlarge'
  }

  const defaultInputs: Record<string, string> = {
    // Base
    'aws-region': 'us-east-1',
    'aws-access-key-id': 'mock-access-key',
    'aws-secret-access-key': 'mock-secret-key',
    'github-org': 'test-org',
    'github-repo': 'test-repo',
    // Provision-specific
    ...provisionSpecificInputs
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should parse all inputs correctly with valid values', () => {
    core.getInput.mockImplementation(
      (name: string) => defaultInputs[name] || ''
    )

    const result = parseProvisionInputs()

    const expectedOutput: ProvisionInputs = {
      ...parseBaseInputs(),
      mode: 'provision',
      instanceCount: 3,
      usageClass: 'spot',
      allowedInstanceTypes: ['c5.large', 'm5.large', 'r*'],
      maxRuntimeMin: 60,
      resourceClass: 'xlarge'
    }

    expect(result).toEqual(expectedOutput)
  })

  it('should use default values when optional inputs are not provided', () => {
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'instance-count': '',
      'allowed-instance-types': '',
      'resource-constraint': '',
      'max-runtime-min': ''
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    const result = parseProvisionInputs()

    expect(result.instanceCount).toBe(PROVISION_DEFAULT['instance-count'])
    expect(result.allowedInstanceTypes).toEqual(
      PROVISION_DEFAULT['allowed-instance-types']
    )
    expect(result.maxRuntimeMin).toBe(PROVISION_DEFAULT['max-runtime-min'])
  })

  it('should correctly split space-separated lists for allowed-instance-types', () => {
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'allowed-instance-types': 't3.micro  t3.small    t3.medium'
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    const result = parseProvisionInputs()

    expect(result.allowedInstanceTypes).toEqual([
      't3.micro',
      't3.small',
      't3.medium'
    ])
  })

  it('should throw error for invalid instance count', () => {
    const key = 'instance-count'
    const value = 'not-a-number'
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'instance-count': value
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    expect(() => parseProvisionInputs()).toThrow(
      `Input "${key}" with value "${value}" is not a valid number`
    )
  })

  it('no provision-specific input should be required', () => {
    // Mock to simulate missing usage-class
    core.getInput.mockImplementation(
      (name: string, options?: { required?: boolean }) => {
        const pKeys = Object.keys(provisionSpecificInputs)
        // if they are provision keys and are called with .required true, then throw an error
        if (pKeys.includes(name) && options?.required === true) {
          throw new Error('Provision input should not be required')
        }
        return defaultInputs[name] || ''
      }
    )

    // blanket, no error
    expect(() => parseProvisionInputs()).not.toThrow()
  })
})

describe('getUsageClass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return "spot" for valid "spot" input', () => {
    core.getInput.mockReturnValue('spot')
    const result = getUsageClass()
    expect(result).toBe('spot')
  })

  it('should return "on-demand" for valid "on-demand" input', () => {
    core.getInput.mockReturnValue('on-demand')
    const result = getUsageClass()
    expect(result).toBe('on-demand')
  })

  it('should return default value when no input is provided', () => {
    core.getInput.mockReturnValue('')
    const result = getUsageClass()
    expect(result).toBe(PROVISION_DEFAULT['usage-class'])
  })

  it('should throw an error for invalid usage class value', () => {
    core.getInput.mockReturnValue('invalid-usage-class')
    expect(() => getUsageClass()).toThrow(
      `usage-class must be 'spot' or 'on-demand', got 'invalid-usage-class'`
    )
  })
})
