import { jest } from '@jest/globals'
import * as core from '../../../../__fixtures__/core' // Use existing mock
import { LTDatav2, RegistrationTokenData } from '../../../../src/services/types' // Import necessary types

// Mock core for LaunchTemplateOperations.cleanIncomingLaunchTemplateData tests
jest.unstable_mockModule('@actions/core', () => core)

// Import the classes containing the static methods we want to test
const {
  IdleTimeOperations,
  SubnetOperations,
  RegistrationTokenOperations,
  MaxRuntimeMinOperations,
  ResourceClassConfigOperations,
  LaunchTemplateOperations
} = await import(
  '../../../../src/services/dynamodb/operations/metadata-operations'
)

describe('Metadata Operations Static Methods', () => {
  beforeEach(() => {
    jest.clearAllMocks() // Clear mocks before each test, especially for core.info
  })

  describe('IdleTimeOperations', () => {
    describe('validateValue', () => {
      it('should return the input number if valid', () => {
        const validTime = 300
        expect(IdleTimeOperations.validateValue(validTime)).toBe(validTime)
      })

      it('should throw an error if input is null', () => {
        expect(() => IdleTimeOperations.validateValue(null)).toThrow(
          'METADATA: idle time not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        // Need to cast undefined to 'any' to satisfy type checking during test writing
        expect(() =>
          IdleTimeOperations.validateValue(undefined as any)
        ).toThrow('METADATA: idle time not defined')
      })

      it('should return 0 if input is 0 as `0` is valid', () => {
        expect(IdleTimeOperations.validateValue(0)).toBe(0)
      })
    })
  })

  describe('SubnetOperations', () => {
    describe('validateValue', () => {
      it('should return the input array if valid', () => {
        const validSubnets = ['subnet-1', 'subnet-2']
        expect(SubnetOperations.validateValue(validSubnets)).toEqual(
          validSubnets
        )
      })

      it('should throw an error if input is null', () => {
        expect(() => SubnetOperations.validateValue(null)).toThrow(
          'METADATA: subnet not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        expect(() => SubnetOperations.validateValue(undefined as any)).toThrow(
          'METADATA: subnet not defined'
        )
      })

      it('should throw an error if input is an empty array', () => {
        expect(() => SubnetOperations.validateValue([])).toThrow(
          'Metadata: no subnet defined'
        )
      })
    })
  })

  describe('RegistrationTokenOperations', () => {
    describe('validateValue', () => {
      let futureDate
      let validTokenData: RegistrationTokenData

      beforeEach(() => {
        futureDate = new Date()
        futureDate.setMinutes(futureDate.getMinutes() + 10)
        validTokenData = {
          token: 'valid_token',
          expires_at: futureDate.toISOString(),
          timestamp: new Date().toISOString()
        }
      })

      it('should return the token data if valid and not expired', () => {
        expect(RegistrationTokenOperations.validateValue(validTokenData)).toBe(
          validTokenData
        )
      })

      it('should throw an error if input is an empty string', () => {
        const emptyTokenData = { ...validTokenData, token: '' }
        expect(() =>
          RegistrationTokenOperations.validateValue(emptyTokenData)
        ).toThrow('METADATA: registration token not defined')
      })

      it('should throw an error if input is null', () => {
        expect(() => RegistrationTokenOperations.validateValue(null)).toThrow(
          'METADATA: registration token not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        expect(() =>
          RegistrationTokenOperations.validateValue(undefined as any)
        ).toThrow('METADATA: registration token not defined')
      })

      it('should throw an error if the token is expired', () => {
        const pastDate = new Date()
        pastDate.setMinutes(pastDate.getMinutes() - 10) // Expired 10 mins ago
        const expiredTokenData = {
          ...validTokenData,
          expires_at: pastDate.toISOString()
        }
        expect(() =>
          RegistrationTokenOperations.validateValue(expiredTokenData)
        ).toThrow(/METADATA: Registration token expired \d+ minutes ago./)
      })
    })
  })

  describe('MaxRuntimeMinOperations', () => {
    describe('validateValue', () => {
      it('should return the input number if valid and non-negative', () => {
        expect(MaxRuntimeMinOperations.validateValue(60)).toBe(60)
        expect(MaxRuntimeMinOperations.validateValue(0)).toBe(0)
      })

      it('should throw an error if input is null', () => {
        expect(() => MaxRuntimeMinOperations.validateValue(null)).toThrow(
          'METADATA: max runtime min not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        expect(() =>
          MaxRuntimeMinOperations.validateValue(undefined as any)
        ).toThrow('METADATA: max runtime min not defined')
      })

      it('should throw an error if input is negative', () => {
        expect(() => MaxRuntimeMinOperations.validateValue(-1)).toThrow(
          'METADATA: recorded max runtime min less than 0'
        )
      })
    })
  })

  describe('ResourceClassConfigOperations', () => {
    describe('validateValue', () => {
      it('should return the config if all entries have queueUrl', () => {
        const validConfig = {
          class1: { queueUrl: 'url1', cpu: 1, mmem: 2048 }, // Add cpu, mmem
          class2: { queueUrl: 'url2', cpu: 2, mmem: 4096 } // Add cpu, mmem
        }
        expect(ResourceClassConfigOperations.validateValue(validConfig)).toBe(
          validConfig
        )
      })

      it('should throw an error if input is null', () => {
        expect(() => ResourceClassConfigOperations.validateValue(null)).toThrow(
          'METADATA: resource class config not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        expect(() =>
          ResourceClassConfigOperations.validateValue(undefined as any)
        ).toThrow('METADATA: resource class config not defined')
      })

      it('should throw an error if any entry lacks a queueUrl', () => {
        const invalidConfig = {
          class1: { queueUrl: 'url1', amiId: 'ami1', cpu: 1, mmem: 2048 }, // Add cpu, mmem
          class2: { cpu: 2, mmem: 4096 }, // Missing queueUrl, Add cpu, mmem
          class3: { cpu: 0.5, mmem: 1024 } // Missing queueUrl, Add cpu, mmem
        }
        expect(() =>
          ResourceClassConfigOperations.validateValue(invalidConfig as any)
        ).toThrow(
          'METADATA: some resource class configs have no associated queues: class2, class3'
        )
      })

      it('should return an empty object if input is an empty object', () => {
        expect(ResourceClassConfigOperations.validateValue({})).toEqual({})
      })
    })
  })

  describe('LaunchTemplateOperations', () => {
    const baseLTData: LTDatav2 = {
      name: 'test-lt',
      ami: 'ami-123', // Renamed from imageId
      iamInstanceProfile:
        'arn:aws:iam::123456789012:instance-profile/TestProfile', // Added required field
      securityGroupIds: ['sg-12345'], // Added required field
      userDataHash: 'hash123'
      // id is not part of LTDatav2
      // instanceType is not part of LTDatav2
    }

    describe('validateValue', () => {
      it('should return the LT data if valid and has a name', () => {
        const validLT = { ...baseLTData }
        expect(LaunchTemplateOperations.validateValue(validLT)).toBe(validLT)
      })

      it('should throw an error if input is null', () => {
        expect(() => LaunchTemplateOperations.validateValue(null)).toThrow(
          'METADATA: lt not defined'
        )
      })

      it('should throw an error if input is undefined', () => {
        expect(() =>
          LaunchTemplateOperations.validateValue(undefined as any)
        ).toThrow('METADATA: lt not defined')
      })

      it('should throw an error if LT data has no name', () => {
        const ltNoName = { ...baseLTData, name: '' }
        expect(() => LaunchTemplateOperations.validateValue(ltNoName)).toThrow(
          'METADATA: lt has not name, likely not yet defined'
        )
        const ltUndefinedName = { ...baseLTData }
        delete ltUndefinedName.name // Simulate missing name property
        expect(() =>
          LaunchTemplateOperations.validateValue(ltUndefinedName as any)
        ).toThrow('METADATA: lt has not name, likely not yet defined')
      })
    })

    describe('validateIncomingLaunchTemplateData', () => {
      it('should return success true and empty messages for valid data', () => {
        const validData = { ...baseLTData } // Has hash, no raw UD
        const result =
          LaunchTemplateOperations.validateIncomingLaunchTemplateData(validData)
        expect(result.success).toBe(true)
        expect(result.messages).toEqual([])
      })

      it('should return success false if userDataHash is missing', () => {
        const invalidData = { ...baseLTData }
        delete invalidData.userDataHash
        const result =
          LaunchTemplateOperations.validateIncomingLaunchTemplateData(
            invalidData
          )
        expect(result.success).toBe(false)
        expect(result.messages).toContain(
          'Hashed User Data hash is required to store in the db'
        )
      })

      it('should return success false if userData is present (too large for db)', () => {
        const invalidData = { ...baseLTData, userData: 'some script' }
        const result =
          LaunchTemplateOperations.validateIncomingLaunchTemplateData(
            invalidData
          )
        expect(result.success).toBe(false)
        expect(result.messages).toContain(
          'User Data cannot be stored in the db'
        )
      })

      it('should return success false if userDataBase64 is present (too large for db)', () => {
        const invalidData = {
          ...baseLTData,
          userDataBase64: 'c29tZSBzY3JpcHQ='
        }
        const result =
          LaunchTemplateOperations.validateIncomingLaunchTemplateData(
            invalidData
          )
        expect(result.success).toBe(false)
        expect(result.messages).toContain(
          'Base64 enc User Data cannot be stored in the db'
        )
      })

      it('should return multiple messages if multiple issues exist', () => {
        const invalidData = {
          ...baseLTData,
          userData: 'some script',
          userDataBase64: 'c29tZSBzY3JpcHQ='
        }
        delete invalidData.userDataHash
        const result =
          LaunchTemplateOperations.validateIncomingLaunchTemplateData(
            invalidData
          )
        expect(result.success).toBe(false)
        expect(result.messages).toHaveLength(3)
        expect(result.messages).toContain(
          'Hashed User Data hash is required to store in the db'
        )
        expect(result.messages).toContain(
          'User Data cannot be stored in the db'
        )
        expect(result.messages).toContain(
          'Base64 enc User Data cannot be stored in the db'
        )
      })
    })

    describe('cleanIncomingLaunchTemplateData', () => {
      it('should remove userData and userDataBase64 fields', () => {
        const dirtyData: LTDatav2 = {
          ...baseLTData,
          userData: 'script',
          userDataBase64: 'base64script'
        }
        const cleaned =
          LaunchTemplateOperations.cleanIncomingLaunchTemplateData(dirtyData)

        expect(cleaned.userData).toBe('')
        expect(cleaned.userDataBase64).toBe('')
        expect(cleaned.name).toBe(baseLTData.name) // Ensure other fields remain
        expect(cleaned.userDataHash).toBe(baseLTData.userDataHash)
      })

      it('should log info messages when removing fields', () => {
        const dirtyData: LTDatav2 = {
          ...baseLTData,
          userData: 'script',
          userDataBase64: 'base64script'
        }
        LaunchTemplateOperations.cleanIncomingLaunchTemplateData(dirtyData)

        expect(core.info).toHaveBeenCalledWith(
          'User Data will not be written to db'
        )
        expect(core.info).toHaveBeenCalledWith(
          'User Data (base64) will not be written to db'
        )
        expect(core.info).toHaveBeenCalledTimes(2) // Once for each message
      })

      it('should not log if fields are already missing/empty', () => {
        const cleanData: LTDatav2 = {
          ...baseLTData,
          userData: '',
          userDataBase64: ''
        }
        const cleaned =
          LaunchTemplateOperations.cleanIncomingLaunchTemplateData(cleanData)

        expect(cleaned.userData).toBe('')
        expect(cleaned.userDataBase64).toBe('')
        expect(core.info).not.toHaveBeenCalled()
      })

      it('should only log for the specific field being removed', () => {
        const dirtyUserData: LTDatav2 = { ...baseLTData, userData: 'script' }
        LaunchTemplateOperations.cleanIncomingLaunchTemplateData(dirtyUserData)
        expect(core.info).toHaveBeenCalledWith(
          'User Data will not be written to db'
        )
        expect(core.info).not.toHaveBeenCalledWith(
          'User Data (base64) will not be written to db'
        )
        expect(core.info).toHaveBeenCalledTimes(1)

        jest.clearAllMocks() // Reset mocks

        const dirtyBase64Data: LTDatav2 = {
          ...baseLTData,
          userDataBase64: 'base64script'
        }
        LaunchTemplateOperations.cleanIncomingLaunchTemplateData(
          dirtyBase64Data
        )
        expect(core.info).not.toHaveBeenCalledWith(
          'User Data will not be written to db'
        )
        expect(core.info).toHaveBeenCalledWith(
          'User Data (base64) will not be written to db'
        )
        expect(core.info).toHaveBeenCalledTimes(1)
      })
    })
  })
})
