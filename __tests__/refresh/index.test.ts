import { jest } from '@jest/globals'
import * as core from '../../__fixtures__/core.js'
import { createDynamoDBService } from '../../__fixtures__/services/dynamodb'
import { createGitHubService } from '../../__fixtures__/services/github'
import { createEC2Service } from '../../__fixtures__/services/ec2'
import {
  manageIdleTime,
  manageSubnetIds,
  manageRegistrationToken,
  manageMaxRuntimeMin,
  manageResourceClassConfiguration,
  manageTerminations
} from '../../__fixtures__/refresh/fixture.js'
import { manageLT } from '../../__fixtures__/refresh/manage-lt'

import { RefreshInputs } from '../../src/inputs/types.js'

Object.entries({
  '@actions/core': core,
  '../../src/services/dynamodb': { createDynamoDBService },
  '../../src/services/github': { createGitHubService },
  '../../src/services/ec2': { createEC2Service },
  '../../src/refresh/manage-idempotent-states': {
    manageIdleTime,
    manageSubnetIds,
    manageMaxRuntimeMin,
    manageResourceClassConfiguration
  },
  '../../src/refresh/manage-terminations': { manageTerminations },
  '../../src/refresh/manage-rt': {
    manageRegistrationToken
  },
  '../../src/refresh/manage-lt': { manageLT }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// actual import
const { refresh } = await import('../../src/refresh')

describe('refresh/index.ts', () => {
  const mockInputs = {} as RefreshInputs

  beforeEach(() => {
    jest.clearAllMocks()
    // Returning a value that is an object with the following properties:
    // - OK for any attribute call
    // - Returns a jest fn that returns {} for every attribute
    const services = [
      createDynamoDBService,
      createGitHubService,
      createEC2Service
    ]
    services.forEach((s) => {
      s.mockReturnValue(
        new Proxy(
          {},
          {
            get: () => jest.fn().mockReturnValue({})
          }
        ) as any // as InstanceType<typeof EC2Service>
      )
    })
  })

  it('manages subnet ids', async () => {
    await refresh(mockInputs)
    expect(manageSubnetIds).toHaveBeenCalled()
  })

  it('manages idle time', async () => {
    await refresh(mockInputs)
    expect(manageIdleTime).toHaveBeenCalled()
  })

  it('manages registration token', async () => {
    await refresh(mockInputs)
    expect(manageRegistrationToken).toHaveBeenCalled()
  })

  it('manages lt', async () => {
    await refresh(mockInputs)
    expect(manageLT).toHaveBeenCalled()
  })

  it('manages mrm', async () => {
    await refresh(mockInputs)
    expect(manageMaxRuntimeMin).toHaveBeenCalled()
  })

  it('logs the execution time', async () => {
    await refresh(mockInputs)
    expect(core.info).toHaveBeenCalledTimes(2)
    expect(core.info).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^Time:/)
    )
    expect(core.info).toHaveBeenLastCalledWith(expect.stringMatching(/^Time:/))
  })
})
