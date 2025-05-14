// launch-template-manager.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import {
  hasLTChanged,
  populateLTName
} from '../../../__fixtures__/refresh/manage-lt/helpers'
import { baseLTInput } from '../../../__fixtures__/refresh/manage-lt'
import * as core from '../../../__fixtures__/core'

// No need for fixtures; Will use "MockProxy" for these
import { LaunchTemplateOperations as EC2LTOps } from '../../../src/services/ec2/operations/launch-template-operations'
import { LaunchTemplateOperations as DDBLTOps } from '../../../src/services/dynamodb/operations/metadata-operations'
import { LTDatav2, GitHubContext } from '../../../src/services/types'

Object.entries({
  '@actions/core': core,
  '../../../src/refresh/manage-lt/helpers': {
    hasLTChanged,
    // declaw implementation
    populateLTName: populateLTName.mockImplementation((input) => input)
  }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { LaunchTemplateManager } = await import('../../../src/refresh/manage-lt')

describe('LaunchTemplateManager', () => {
  const tableName = 'test-table'
  const context: GitHubContext = { repo: 'repo-name', owner: 'owner-name' }
  let ec2Ops: MockProxy<EC2LTOps>
  let ddbOps: MockProxy<DDBLTOps>
  let manager: InstanceType<typeof LaunchTemplateManager>
  const mockLTInput: LTDatav2 = { ...baseLTInput }

  beforeEach(() => {
    jest.clearAllMocks()
    ec2Ops = mock<EC2LTOps>()
    ddbOps = mock<DDBLTOps>()
    manager = new LaunchTemplateManager(tableName, context, ec2Ops, ddbOps)

    // Set up default mocks with correct response structure
    ec2Ops.createLaunchTemplate.mockResolvedValue({
      Warning: { Errors: [] }
    } as any)
    ec2Ops.createLaunchTemplateVersion.mockResolvedValue({
      LaunchTemplateVersion: { VersionNumber: 2 }
    } as any)
  })

  describe('manage', () => {
    it('calls upon a helper to populate lt name', async () => {
      await manager.manage(mockLTInput)
      expect(populateLTName).toHaveBeenCalled()
    })

    it('throws an exception if theres no UD provided', async () => {
      await expect(
        manager.manage({ ...mockLTInput, userData: '' })
      ).rejects.toThrow('User Data must be provided')
    })

    describe('when first time creating an lt', () => {
      beforeEach(() => {
        ddbOps.getLaunchTemplateData.mockResolvedValue(null)
      })

      it('should call on create lt only if no stored data found', async () => {
        await manager.manage(mockLTInput)
        expect(ec2Ops.createLaunchTemplate).toHaveBeenCalled()
        expect(ddbOps.updateLaunchTemplateData).toHaveBeenCalled()
        expect(ec2Ops.createLaunchTemplateVersion).not.toHaveBeenCalled()
      })

      // what if there's an error encountered on creation ?
      it('should log a failed message on failed creation', async () => {
        const msg = 'Some Warning'
        ec2Ops.createLaunchTemplate.mockResolvedValue({
          Warning: {
            Errors: [{ Message: msg }]
          }
        } as any)

        await expect(manager.manage(mockLTInput)).rejects.toThrow(msg)
        expect(core.error).toHaveBeenCalled()
      })
    })

    describe('when lt exists', () => {
      beforeEach(() => {
        ddbOps.getLaunchTemplateData.mockResolvedValue({} as any)
      })

      it('should not call on lt creation/update if stored data found and LT has not changed', async () => {
        hasLTChanged.mockReturnValue(false)

        await manager.manage(mockLTInput)
        expect(ec2Ops.createLaunchTemplate).not.toHaveBeenCalled()
        expect(ec2Ops.createLaunchTemplateVersion).not.toHaveBeenCalled()
        expect(ddbOps.updateLaunchTemplateData).not.toHaveBeenCalled()
      })

      describe('and when lt has changed', () => {
        beforeEach(() => {
          hasLTChanged.mockReturnValue(true)
        })
        it('should call on to create new lt version and set default lt when data is found an lt has changed', async () => {
          await manager.manage(mockLTInput)
          expect(ec2Ops.createLaunchTemplate).not.toHaveBeenCalled()
          expect(ddbOps.updateLaunchTemplateData).toHaveBeenCalled()
          expect(ec2Ops.createLaunchTemplateVersion).toHaveBeenCalled()
          expect(ec2Ops.modifyLaunchTemplate).toHaveBeenCalled()
        })

        // what if its still true, but there's errors on create version
        it('should log an error message on failed version creation', async () => {
          ec2Ops.createLaunchTemplateVersion.mockResolvedValue({} as any)
          await expect(manager.manage(mockLTInput)).rejects.toThrow(
            'Failed to create a new LT version'
          )
          expect(core.error).toHaveBeenCalled()
          expect(ec2Ops.modifyLaunchTemplate).not.toHaveBeenCalled()
        })
      })
    })
  })
})
