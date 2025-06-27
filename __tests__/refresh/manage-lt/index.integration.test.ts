// launch-template-manager.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { LaunchTemplateOperations as EC2LTOps } from '../../../src/services/ec2/operations/launch-template-operations'
import { LaunchTemplateOperations as DDBLTOps } from '../../../src/services/dynamodb/operations/metadata-operations'
import {
  baseLTInput,
  defaultLTDataName
} from '../../../__fixtures__/refresh/manage-lt'
import { LTDatav2, GitHubContext } from '../../../src/services/types'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { LaunchTemplateManager } = await import('../../../src/refresh/manage-lt')

describe('LaunchTemplateManager', () => {
  const tableName = 'test-table'
  const actionsRunnerVersion = '1.1.1.1'
  const context: GitHubContext = { repo: 'repo-name', owner: 'owner-name' }
  let ec2Ops: MockProxy<EC2LTOps>
  let ddbOps: MockProxy<DDBLTOps>
  let manager: InstanceType<typeof LaunchTemplateManager>

  // Base mock data
  const mockLTInput: LTDatav2 = { ...baseLTInput, name: defaultLTDataName }

  const mockLTInputFullUD: LTDatav2 = {
    ...mockLTInput,
    userDataBase64: expect.any(String),
    userDataHash: expect.any(String)
  }

  beforeEach(() => {
    ec2Ops = mock<EC2LTOps>()
    ddbOps = mock<DDBLTOps>()
    manager = new LaunchTemplateManager(
      tableName,
      context,
      actionsRunnerVersion,
      ec2Ops,
      ddbOps
    )

    // Set up default mocks with correct response structure
    ec2Ops.createLaunchTemplate.mockResolvedValue({
      Warning: { Errors: [] }
    } as any)
    ec2Ops.createLaunchTemplateVersion.mockResolvedValue({
      LaunchTemplateVersion: { VersionNumber: 2 }
    } as any)
  })

  describe('manage', () => {
    it('should create new launch template when no stored data exists', async () => {
      ddbOps.getLaunchTemplateData.mockResolvedValue(null)

      await manager.manage(mockLTInput)

      expect(ec2Ops.createLaunchTemplate).toHaveBeenCalledWith(
        mockLTInputFullUD
      )
      expect(ddbOps.updateLaunchTemplateData).toHaveBeenCalledWith(
        mockLTInputFullUD
      )
    })

    describe('when no db data exists but launch template with exact name exists', () => {
      it('should should delete that lt first, then re-create it', async () => {
        ddbOps.getLaunchTemplateData.mockResolvedValue(null)
        ec2Ops.launchTemplateExists.mockResolvedValue(true)

        await manager.manage(mockLTInput)

        expect(ec2Ops.deleteLaunchTemplate).toHaveBeenCalled()
        expect(ec2Ops.createLaunchTemplate).toHaveBeenCalled()
      })
    })

    it('should handle custom launch template names', async () => {
      const customNameInput: LTDatav2 = {
        ...mockLTInputFullUD,
        name: 'custom-lt-name'
      }
      const ltManager = new LaunchTemplateManager(
        tableName,
        context,
        actionsRunnerVersion,
        ec2Ops,
        ddbOps,
        'custom-lt-name'
      )
      ddbOps.getLaunchTemplateData.mockResolvedValue(null)

      await ltManager.manage(customNameInput)

      expect(ec2Ops.createLaunchTemplate).toHaveBeenCalledWith(customNameInput)
    })

    it('should detect changes in security groups', async () => {
      const storedData: LTDatav2 = {
        ...mockLTInput,
        securityGroupIds: ['sg-123'] // different security groups
      }
      ddbOps.getLaunchTemplateData.mockResolvedValue(storedData)

      await manager.manage(mockLTInput)

      expect(ec2Ops.createLaunchTemplateVersion).toHaveBeenCalled()
    })

    it('should detect changes in AMI', async () => {
      const storedData: LTDatav2 = {
        ...mockLTInput,
        ami: 'ami-98765' // different AMI
      }
      ddbOps.getLaunchTemplateData.mockResolvedValue(storedData)

      await manager.manage(mockLTInput)

      expect(ec2Ops.createLaunchTemplateVersion).toHaveBeenCalled()
    })

    it('should throw error when userData is not provided', async () => {
      const invalidInput: LTDatav2 = {
        ...mockLTInput,
        userData: undefined
      }

      await expect(manager.manage(invalidInput)).rejects.toThrow(
        'User Data must be provided'
      )
    })

    // Test for warning/errors in createLaunchTemplate
    it('should throw error when creation has warnings', async () => {
      ec2Ops.createLaunchTemplate.mockResolvedValue({
        Warning: {
          Errors: [{ Message: 'Some warning' }]
        }
      } as any)
      ddbOps.getLaunchTemplateData.mockResolvedValue(null)

      await expect(manager.manage(mockLTInput)).rejects.toThrow('Some warning')
    })

    // Test for failure in creating a version
    it('should throw error when version creation fails', async () => {
      const storedData: LTDatav2 = {
        ...mockLTInput,
        ami: 'ami-98765' // different AMI
      }
      ddbOps.getLaunchTemplateData.mockResolvedValue(storedData)
      ec2Ops.createLaunchTemplateVersion.mockResolvedValue({} as any) // No version number

      await expect(manager.manage(mockLTInput)).rejects.toThrow(
        'Failed to create a new LT version'
      )
    })
  })
})
