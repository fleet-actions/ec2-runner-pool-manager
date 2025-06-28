import { jest } from '@jest/globals'
import * as core from '../../__fixtures__/core.js'
import type { RefreshInputs } from '../../src/inputs/types.js'

import {
  parseBaseInputs,
  REFRESH_DEFAULTS,
  RESOURCE_CLASS_CONFIG_DEFAULT
} from '../../__fixtures__/inputs/fixtures.js'

Object.entries({
  '@actions/core': core,
  '../../src/inputs/base-inputs': { parseBaseInputs },
  '../../src/inputs/defaults': {
    REFRESH_DEFAULTS,
    RESOURCE_CLASS_CONFIG_DEFAULT
  }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// actual import
const {
  parseRefreshInputs,
  getResourceClassConfig,
  getGithubRegTokenRefreshMins
} = await import('../../src/inputs/refresh-inputs.js')

describe('parseRefreshInputs', () => {
  // Define default valid inputs that we can override for specific tests
  const defaultInputs: Record<string, string> = {
    'idle-time-sec': '300',
    'github-reg-token-refresh-min': '30',
    'actions-runner-version': '1.1.1.1',
    'github-token': 'gh-token-123',
    ami: 'ami-123456',
    'iam-instance-profile': 'instance-profile-1',
    'security-group-ids': 'sg-123 sg-456',
    'pre-runner-script': '#!/bin/bash\necho "hello"',
    'subnet-ids': 'subnet-123 subnet-456',
    'resource-class-config': '', // empty to use default
    'max-runtime-min': '30',
    // Add base inputs that would be required
    'aws-region': 'us-east-1',
    'aws-access-key-id': 'mock-access-key',
    'aws-secret-access-key': 'mock-secret-key',
    'github-org': 'test-org',
    'github-repo': 'test-repo'
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should parse all inputs correctly with valid values', () => {
    core.getInput.mockImplementation(
      (name: string) => defaultInputs[name] || ''
    )

    const result = parseRefreshInputs()

    const expectedOutput: RefreshInputs = {
      ...parseBaseInputs(),
      mode: 'refresh',
      actionsRunnerVersion: '1.1.1.1',
      idleTimeSec: 300,
      maxRuntimeMin: 30,
      githubRegTokenRefreshMins: 30,
      githubToken: 'gh-token-123',
      ami: 'ami-123456',
      iamInstanceProfile: 'instance-profile-1',
      securityGroupIds: ['sg-123', 'sg-456'],
      preRunnerScript: '#!/bin/bash\necho "hello"',
      subnetIds: ['subnet-123', 'subnet-456'],
      resourceClassConfig: RESOURCE_CLASS_CONFIG_DEFAULT
    }

    expect(result).toEqual(expectedOutput)
  })

  it('should throw error for invalid idle time', () => {
    const key = 'idle-time-sec'
    const value = 'not-a-number'
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'idle-time-sec': value
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    expect(() => parseRefreshInputs()).toThrow(
      `Input "${key}" with value "${value}" is not a valid number`
    )
  })

  it('should throw error for token refresh time >= 60 minutes', async () => {
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'github-reg-token-refresh-min': '60'
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    expect(() => parseRefreshInputs()).toThrow(
      'github-reg-token-refresh-min must be less than 60 mins'
    )
  })

  it('should return the custom resource class when provided', async () => {
    const customRC = JSON.parse('{"custom": {"cpu": 1, "mmem": 2}}')
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'resource-class-config': JSON.stringify(customRC)
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    const result = parseRefreshInputs()

    expect(result.resourceClassConfig).toMatchObject(customRC)
  })

  it('should correctly split space-separated lists', async () => {
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'security-group-ids': 'sg-1  sg-2    sg-3',
      'subnet-ids': 'subnet-1 subnet-2'
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    const result = parseRefreshInputs()

    expect(result.securityGroupIds).toEqual(['sg-1', 'sg-2', 'sg-3'])
    expect(result.subnetIds).toEqual(['subnet-1', 'subnet-2'])
  })

  it('should use default resource class config when no custom config provided', () => {
    const testInputs: Record<string, string> = {
      ...defaultInputs,
      'resource-class-config': ''
    }
    core.getInput.mockImplementation((name: string) => testInputs[name] || '')

    const result = parseRefreshInputs()

    expect(result.resourceClassConfig).toBe(RESOURCE_CLASS_CONFIG_DEFAULT)
  })

  it('should require all mandatory fields', () => {
    // Mock to simulate missing github-token
    core.getInput.mockImplementation(
      (name: string, options?: { required?: boolean }) => {
        if (name === 'github-token' && options?.required) {
          throw new Error('Input required and not supplied: github-token')
        }
        return defaultInputs[name] || ''
      }
    )

    expect(() => parseRefreshInputs()).toThrow(
      'Input required and not supplied: github-token'
    )
  })
})

describe('getResourceClassConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return valid config for correct input', () => {
    const validConfig = JSON.stringify({
      small: { cpu: '2', mmem: '1024' },
      medium: { cpu: '4', mmem: '2048' },
      large: { cpu: '8', mmem: '4096' }
    })
    core.getInput.mockReturnValue(validConfig)

    const config = getResourceClassConfig()
    expect(config).toEqual({
      small: { cpu: 2, mmem: 1024 },
      medium: { cpu: 4, mmem: 2048 },
      large: { cpu: 8, mmem: 4096 }
    })
  })

  it('should throw an error for malformed JSON input', () => {
    core.getInput.mockReturnValue('{malformed}')
    expect(() => getResourceClassConfig()).toThrow() // JSON.parse should throw
  })

  it('should throw an error if a cpu value is invalid (e.g. zero)', () => {
    const invalidCpu = JSON.stringify({
      small: { cpu: '0', mmem: '1024' }
    })
    core.getInput.mockReturnValue(invalidCpu)
    expect(() => getResourceClassConfig()).toThrow(/cpu value.*is invalid/)
  })

  it('should throw an error if duplicate CPU values are detected', () => {
    const duplicateCpu = JSON.stringify({
      small: { cpu: '2', mmem: '1024' },
      small2: { cpu: '2', mmem: '2048' }
    })
    core.getInput.mockReturnValue(duplicateCpu)
    expect(() => getResourceClassConfig()).toThrow(
      /Duplicate CPU values detected/
    )
  })

  it('should throw an error if memory does not strictly increase with CPU', () => {
    // "small" has cpu 2 with mmem 1024 but "medium" has cpu 4 with mmem 512
    const badMemory = JSON.stringify({
      small: { cpu: '2', mmem: '1024' },
      medium: { cpu: '4', mmem: '512' }
    })
    core.getInput.mockReturnValue(badMemory)
    expect(() => getResourceClassConfig()).toThrow(
      /Memory for resource class "medium".*must be greater than memory for "small"/
    )
  })

  describe('Edge Cases: Missing or Non-Numeric Attributes', () => {
    it('should throw an error when the cpu attribute is missing', () => {
      const missingCpu = JSON.stringify({
        small: { mmem: '1024' }
      })
      core.getInput.mockReturnValue(missingCpu)
      expect(() => getResourceClassConfig()).toThrow(/cpu attribute is missing/)
    })

    it('should throw an error when the mmem attribute is missing', () => {
      const missingMmem = JSON.stringify({
        small: { cpu: '2' }
      })
      core.getInput.mockReturnValue(missingMmem)
      expect(() => getResourceClassConfig()).toThrow(
        /mmem attribute is missing/
      )
    })

    it('should throw an error when both cpu and mmem attributes are missing', () => {
      const missingBoth = JSON.stringify({
        small: {}
      })
      core.getInput.mockReturnValue(missingBoth)
      expect(() => getResourceClassConfig()).toThrow(/cpu attribute is missing/)
    })

    it('should throw an error when cpu attribute value is non-numeric', () => {
      const nonNumericCpu = JSON.stringify({
        small: { cpu: 'abc', mmem: '1024' }
      })
      core.getInput.mockReturnValue(nonNumericCpu)
      expect(() => getResourceClassConfig()).toThrow(
        /cpu value "abc" is invalid/
      )
    })

    it('should throw an error when mmem attribute value is non-numeric', () => {
      const nonNumericMmem = JSON.stringify({
        small: { cpu: '2', mmem: 'xyz' }
      })
      core.getInput.mockReturnValue(nonNumericMmem)
      expect(() => getResourceClassConfig()).toThrow(
        /mmem value "xyz" is invalid/
      )
    })
  })
})

describe('getGithubRegTokenRefreshMins', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return the default value (30) when no input is provided', () => {
    core.getInput.mockReturnValue('')
    const result = getGithubRegTokenRefreshMins()
    expect(result).toBe(30)
    // Under the hood, getNumber('github-reg-token-refresh-min', false, 30) will return 30.
  })

  it('should return the provided number when less than 60', () => {
    core.getInput.mockReturnValue('25')
    const result = getGithubRegTokenRefreshMins()
    expect(result).toBe(25)
  })

  it('should throw an error when the input value is >= 60', () => {
    core.getInput.mockReturnValue('60')
    expect(() => getGithubRegTokenRefreshMins()).toThrow(
      'github-reg-token-refresh-min must be less than 60 mins'
    )
  })

  it('should throw an error when the input value is greater than 60', () => {
    core.getInput.mockReturnValue('75')
    expect(() => getGithubRegTokenRefreshMins()).toThrow(
      'github-reg-token-refresh-min must be less than 60 mins'
    )
  })
})
