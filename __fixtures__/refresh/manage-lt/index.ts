import { jest } from '@jest/globals'
import { LTDatav2 } from '../../../src/services/types.js'

// Mocking a class!
export const LaunchTemplateManager = jest.fn() as jest.Mocked<
  typeof import('../../../src/refresh/manage-lt/index.js').LaunchTemplateManager
>

export const manageLT =
  jest.fn<typeof import('../../../src/refresh/manage-lt/index.js').manageLT>()

// Default name for lt
export const defaultLTDataName = 'runner-pool-base-lt'

/**
 * Base Launch Template data fixture with minimal required fields
 */
export const baseLTInput: LTDatav2 = {
  ami: 'ami-123456789',
  iamInstanceProfile: 'test-profile',
  securityGroupIds: ['sg-123', 'sg-456'],
  userData: expect.any(String)
}
