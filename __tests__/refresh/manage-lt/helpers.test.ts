import { jest } from '@jest/globals'
import {
  baseLTInput,
  defaultLTDataName
} from '../../../__fixtures__/refresh/manage-lt'
import { LTDatav2 } from '../../../src/services/types'
import * as core from '../../../__fixtures__/core'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { hasLTChanged, populateLTName } = await import(
  '../../../src/refresh/manage-lt/helpers'
)

describe('Launch Template Helpers', () => {
  // Sample data for tests
  const baseLTData: LTDatav2 = { ...baseLTInput, name: defaultLTDataName }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('hasLTChanged', () => {
    it('should return false when no changes are detected', () => {
      const result = hasLTChanged(baseLTData, { ...baseLTData })
      expect(result).toBe(false)
    })

    it('should throw error when LT names do not match', () => {
      const newData = { ...baseLTData, name: 'different-name' }
      expect(() => hasLTChanged(newData, baseLTData)).toThrow(
        /new lt name found/
      )
    })

    it('should detect AMI changes', () => {
      const newData = { ...baseLTData, ami: 'ami-456' }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new ami detected')
      )
    })

    it('should detect IAM profile changes', () => {
      const newData = { ...baseLTData, iamInstanceProfile: 'new-profile-123' }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new instance profile detected')
      )
    })

    it('should detect user data changes', () => {
      const newData = { ...baseLTData, userDataHash: 'def456' }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('modified user data script detected')
      )
    })

    it('should detect security group changes', () => {
      const newData = { ...baseLTData, securityGroupIds: ['sg-123', 'sg-789'] }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new sgs detected')
      )
    })

    it('should detect security group count changes', () => {
      const newData = { ...baseLTData, securityGroupIds: ['sg-123'] }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new number of sgs detected')
      )
    })

    it('should detect multiple changes and display messages accordingly', () => {
      const newData = {
        ...baseLTData,
        securityGroupIds: ['sg-123'],
        ami: 'abc-linux-v1'
      }
      const result = hasLTChanged(newData, baseLTData)
      expect(result).toBe(true)

      // expect both ami and sgs
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new number of sgs detected')
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('new ami detected')
      )
    })
  })

  describe('populateLTName', () => {
    it('should use existing name if present', () => {
      const input = { ...baseLTData }
      const result = populateLTName(input, 'new-name')
      expect(result.name).toBe(defaultLTDataName)
    })

    it('should use provided name if no existing name', () => {
      const input = { ...baseLTData, name: undefined }
      const result = populateLTName(input, 'new-name')
      expect(result.name).toBe('new-name')
    })
  })

  // TODO: src/refresh/manage-lt/userdata.ts/addUDWithBaseAndHash
  // NOTE: This is where the test should live now
  // describe('populateUserData', () => {
  //   it('should throw error if userData is not provided', () => {
  //     const input = { ...baseLTData, userData: undefined }
  //     expect(() => populateUserData(input)).toThrow(
  //       'User Data must be provided'
  //     )
  //   })

  //   it('should generate hash and base64 from userData', () => {
  //     const input = { ...baseLTData, userData: 'test-script' }
  //     const result = populateUserData(input)

  //     expect(result.userDataHash).toBeDefined()
  //     expect(result.userDataBase64).toBe(
  //       Buffer.from('test-script').toString('base64')
  //     )
  //     // We can't test the exact hash value as it depends on the crypto implementation
  //     expect(result.userDataHash?.length).toBeGreaterThan(0)
  //     // importantly, userData itself is unaffected
  //     expect(result.userData).toEqual(input.userData)
  //   })

  //   it('should preserve original data while adding hash and base64', () => {
  //     const input = { ...baseLTData }
  //     const result = populateUserData(input)

  //     expect(result.ami).toBe(input.ami)
  //     expect(result.iamInstanceProfile).toBe(input.iamInstanceProfile)
  //     expect(result.securityGroupIds).toEqual(input.securityGroupIds)
  //     // importantly, userData itself is unaffected
  //     expect(result.userData).toEqual(input.userData)
  //   })
  // })
})
