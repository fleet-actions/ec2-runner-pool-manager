// __tests__/release/release-resources.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../__fixtures__/core' // Assuming you have a similar mock for @actions/core
import { transitionToIdle, sendToPools } from '../../__fixtures__/release'

import {
  InstanceOperations,
  InstanceItem,
  InstanceStates
} from '../../src/services/dynamodb/operations/instance-operations'
import type { ResourceClassConfigOperations } from '../../src/services/sqs/operations/resource-class-operations'
import { ResourceClassConfig } from '../../src/services/types'
import type { ReleaseResourcesInput } from '../../src/release/release-resources'

// Mock @actions/core and other modules
Object.entries({
  '@actions/core': core,
  '../../src/release/transition-to-idle.js': {
    transitionToIdle
  },
  '../../src/release/send-to-pools.js': { sendToPools }
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

const { releaseResources } = await import('../../src/release/release-resources')

describe('releaseResources', () => {
  let mockDdbOps: MockProxy<InstanceOperations>
  let mockSqsOps: MockProxy<ResourceClassConfigOperations>
  let releaseResourcesInput: ReleaseResourcesInput

  const sampleResourceClass = 'large'
  const sampleInstanceType = 'c5.large'
  const sampleRunId = 'test-run-id-release-123'
  const sampleIdleTimeSec = 300
  const sampleResourceClassConfig: ResourceClassConfig = {
    large: { cpu: 2, mmem: 4096, queueUrl: 'queueurl.com' }
  }

  // Corrected helper function based on the InstanceItem definition
  const createMockInstanceItem = (
    identifier: string,
    state: InstanceStates,
    runIdInput?: string // Renamed to avoid conflict with InstanceItem.runId
  ): InstanceItem => {
    const nowISO = new Date().toISOString()
    return {
      // Properties from BasicItem (these would be set by DynamoDB operations)
      // For mocking purposes, we might not need all of them if the functions
      // under test (transitionToIdle, sendToPools mocks) don't rely on them.
      // However, for completeness if they were needed:
      PK: `INSTANCE#${sampleResourceClassConfig.resourceClass}`, // Example PK
      SK: identifier, // Example SK
      entityType: 'INSTANCE',
      updatedAt: nowISO,

      // InstanceItem specific properties
      identifier,
      state,
      threshold: nowISO, // Added: Important for state transitions, using current time as a default
      runId: runIdInput || sampleRunId, // Uses input or a default sampleRunId
      resourceClass: sampleResourceClass, // From config
      instanceType: sampleInstanceType // Added: From config
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockDdbOps = mock<InstanceOperations>()
    mockSqsOps = mock<ResourceClassConfigOperations>()

    releaseResourcesInput = {
      resourceClassConfig: sampleResourceClassConfig,
      runId: sampleRunId,
      idleTimeSec: sampleIdleTimeSec,
      ddbOps: mockDdbOps,
      sqsOps: mockSqsOps
    }

    mockDdbOps.getInstancesByRunId.mockResolvedValue([])
    transitionToIdle.mockResolvedValue({ successful: [], unsuccessful: [] })
    sendToPools.mockResolvedValue(undefined)
  })

  // --- Existing Test Scenarios ---

  it('Scenario 1: Perfect Run (All Running Instances Successfully Released)', async () => {
    const runningInstance1 = createMockInstanceItem('i-running1', 'running')
    const runningInstance2 = createMockInstanceItem('i-running2', 'running')
    const mockInstances = [runningInstance1, runningInstance2]

    mockDdbOps.getInstancesByRunId.mockResolvedValue(mockInstances)
    transitionToIdle.mockResolvedValue({
      successful: mockInstances, // all running instances from classification
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    expect(core.info).toHaveBeenCalledWith(
      'Starting release resources routine...'
    )
    // Check that getInstancesByRunId was called correctly
    expect(mockDdbOps.getInstancesByRunId).toHaveBeenCalledWith(sampleRunId)

    // Check that classifyInstancesByState would pass only running instances to transitionToIdle
    const classifiedRunningInstances = mockInstances.filter(
      (inst) => inst.state === 'running'
    )
    expect(transitionToIdle).toHaveBeenCalledWith(
      classifiedRunningInstances,
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )
    expect(sendToPools).toHaveBeenCalledWith(
      classifiedRunningInstances, // these are the 'successful' ones
      sampleResourceClassConfig,
      mockSqsOps
    )
    expect(core.info).toHaveBeenCalledWith('Release completed successfully 🎉')
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it("Scenario 2: Handles 'claimed' instances and continues release for others", async () => {
    const claimedInstance = createMockInstanceItem('i-claimed1', 'claimed')
    const runningInstance = createMockInstanceItem('i-running1', 'running')
    mockDdbOps.getInstancesByRunId.mockResolvedValue([
      claimedInstance,
      runningInstance
    ])
    // transitionToIdle is only called with 'running' instances after classification
    transitionToIdle.mockResolvedValue({
      successful: [runningInstance],
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Informative Log: ID (i-claimed1) has a state of claimed'
      )
    )
    expect(core.warning).toHaveBeenCalledWith(
      // From logInstanceState via classifyInstancesByState
      `❌ Found as 'claimed' - release will be marked for failure after other resources are released`
    )
    expect(core.warning).toHaveBeenCalledWith(
      // From main releaseResources logic
      `Found instances with runId ${sampleRunId} that are in 'claimed' state: ${claimedInstance.identifier}`
    )

    expect(transitionToIdle).toHaveBeenCalledWith(
      [runningInstance], // Only the running instance
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )
    expect(sendToPools).toHaveBeenCalledWith(
      [runningInstance],
      sampleResourceClassConfig,
      mockSqsOps
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        `Found instances with runId ${sampleRunId} that are in 'claimed' state: ${claimedInstance.identifier}`
      )
    )
  })

  it("Scenario 3: Handles 'idle' instances (unexpectedly found with runId) and continues release", async () => {
    const idleInstance = createMockInstanceItem('i-idle1', 'idle')
    const runningInstance = createMockInstanceItem('i-running2', 'running')
    mockDdbOps.getInstancesByRunId.mockResolvedValue([
      idleInstance,
      runningInstance
    ])
    transitionToIdle.mockResolvedValue({
      successful: [runningInstance],
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Informative Log: ID (i-idle1) has a state of idle'
      )
    )
    expect(core.info).toHaveBeenCalledWith(
      // from logInstanceState via classifyInstancesByState
      `❌ Found as 'idle' - idle instances should not be found with a runId. Release will be marked for failure`
    )
    expect(core.warning).toHaveBeenCalledWith(
      // From main releaseResources logic
      `Found instances with runId ${sampleRunId} that are in 'idle' state: ${idleInstance.identifier}`
    )
    expect(sendToPools).toHaveBeenCalledWith(
      [runningInstance],
      sampleResourceClassConfig,
      mockSqsOps
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        `Found instances with runId ${sampleRunId} that are in 'idle' state: ${idleInstance.identifier}`
      )
    )
  })

  it('Scenario 4: Partial Failure in transitionToIdle', async () => {
    const successInstance = createMockInstanceItem('i-success1', 'running')
    const failInstance = createMockInstanceItem('i-fail1', 'running')
    // Both are initially running
    mockDdbOps.getInstancesByRunId.mockResolvedValue([
      successInstance,
      failInstance
    ])
    // transitionToIdle is called with both, but one fails
    transitionToIdle.mockResolvedValue({
      successful: [successInstance],
      unsuccessful: [failInstance]
    })

    await releaseResources(releaseResourcesInput)

    expect(transitionToIdle).toHaveBeenCalledWith(
      [successInstance, failInstance], // Both running instances are passed to transitionToIdle
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )
    expect(core.warning).toHaveBeenCalledWith(
      `The ids: (${failInstance.identifier}) failed to transition from running to idle. We are only releasing the following ids: (${successInstance.identifier})`
    )
    expect(sendToPools).toHaveBeenCalledWith(
      [successInstance],
      sampleResourceClassConfig,
      mockSqsOps
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        `The ids: (${failInstance.identifier}) failed to transition from running to idle.`
      )
    )
  })

  it('Scenario 5: Total Failure in transitionToIdle (No Instances Successfully Transitioned)', async () => {
    const failInstance1 = createMockInstanceItem('i-fail1', 'running')
    const failInstance2 = createMockInstanceItem('i-fail2', 'running')
    const allRunningInstances = [failInstance1, failInstance2]
    mockDdbOps.getInstancesByRunId.mockResolvedValue(allRunningInstances)
    transitionToIdle.mockResolvedValue({
      successful: [],
      unsuccessful: allRunningInstances
    })

    await releaseResources(releaseResourcesInput)

    expect(transitionToIdle).toHaveBeenCalledWith(
      allRunningInstances,
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )
    expect(core.warning).toHaveBeenCalledWith(
      `The ids: (${failInstance1.identifier},${failInstance2.identifier}) failed to transition from running to idle. We are only releasing the following ids: ()`
    )
    // Based on current logic: if successful.length is 0, sendToPools is not called.
    expect(sendToPools).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'No instances were successfully transitioned to idle state'
      )
    )
  })

  it('Scenario 6: No Instances Found for the runId', async () => {
    mockDdbOps.getInstancesByRunId.mockResolvedValue([])
    // transitionToIdle will be called with empty array from classification
    transitionToIdle.mockResolvedValue({ successful: [], unsuccessful: [] })

    await releaseResources(releaseResourcesInput)

    expect(transitionToIdle).toHaveBeenCalledWith(
      [], // Empty array of 'running' instances after classification
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )
    expect(sendToPools).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'No instances were successfully transitioned to idle state'
      )
    )
  })

  it('Scenario 7: Combination of Issues (claimed, idle, and transition failure)', async () => {
    const claimedInst = createMockInstanceItem('i-claimedmix', 'claimed')
    const idleInst = createMockInstanceItem('i-idlemix', 'idle')
    const runningSuccessInst = createMockInstanceItem(
      'i-runsuccessmix',
      'running'
    )
    const runningFailInst = createMockInstanceItem('i-runfailmix', 'running')
    const runningInstancesForTransition = [runningSuccessInst, runningFailInst]

    mockDdbOps.getInstancesByRunId.mockResolvedValue([
      claimedInst,
      idleInst,
      runningSuccessInst,
      runningFailInst
    ])
    transitionToIdle.mockResolvedValue({
      successful: [runningSuccessInst],
      unsuccessful: [runningFailInst]
    })

    await releaseResources(releaseResourcesInput)

    expect(transitionToIdle).toHaveBeenCalledWith(
      runningInstancesForTransition, // Only running instances passed
      sampleRunId,
      sampleIdleTimeSec,
      mockDdbOps
    )

    // Check warnings for claimed and idle
    expect(core.warning).toHaveBeenCalledWith(
      `Found instances with runId ${sampleRunId} that are in 'claimed' state: ${claimedInst.identifier}`
    )
    expect(core.warning).toHaveBeenCalledWith(
      `Found instances with runId ${sampleRunId} that are in 'idle' state: ${idleInst.identifier}`
    )
    // Check warning for transition failure
    expect(core.warning).toHaveBeenCalledWith(
      `The ids: (${runningFailInst.identifier}) failed to transition from running to idle. We are only releasing the following ids: (${runningSuccessInst.identifier})`
    )

    // Check sendToPools only with successfully transitioned
    expect(sendToPools).toHaveBeenCalledWith(
      [runningSuccessInst],
      sampleResourceClassConfig,
      mockSqsOps
    )

    // Check core.setFailed includes all messages
    const expectedErrorMessages = [
      `Found instances with runId ${sampleRunId} that are in 'claimed' state: ${claimedInst.identifier}`,
      `Found instances with runId ${sampleRunId} that are in 'idle' state: ${idleInst.identifier}`,
      `The ids: (${runningFailInst.identifier}) failed to transition from running to idle. We are only releasing the following ids: (${runningSuccessInst.identifier})`
    ]
    const expectedFullFailureMessage = `Release completed with errors 😬:\n${expectedErrorMessages.join('\n')}`
    expect(core.setFailed).toHaveBeenCalledWith(expectedFullFailureMessage)
  })

  // TODO: Consider better handling like resource dumping
  describe('Errored screnarios', () => {
    it('Scenario: Error during sendToPools', async () => {
      const runningInstance = createMockInstanceItem(
        'i-running-sendfail',
        'running'
      )
      mockDdbOps.getInstancesByRunId.mockResolvedValue([runningInstance])
      transitionToIdle.mockResolvedValue({
        successful: [runningInstance],
        unsuccessful: []
      })

      const sendToPoolsError = new Error('SQS send error')
      sendToPools.mockRejectedValueOnce(sendToPoolsError)

      await expect(releaseResources(releaseResourcesInput)).rejects.toThrow(
        sendToPoolsError
      )

      // Verify that core.setFailed was not called because the error should propagate
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        `Releasing 1 successfully transitioned instances to pool` // This log occurs before sendToPools
      )
      // Warnings related to instance states or transitions should not have occurred
      expect(core.warning).not.toHaveBeenCalled()
    })

    it('Scenario: Error during ddbOps.getInstancesByRunId', async () => {
      const ddbError = new Error('DynamoDB getInstancesByRunId failed')
      mockDdbOps.getInstancesByRunId.mockRejectedValueOnce(ddbError)

      await expect(releaseResources(releaseResourcesInput)).rejects.toThrow(
        ddbError
      )

      // Verify that core.setFailed was not called
      expect(core.setFailed).not.toHaveBeenCalled()
      // Verify that no other processing calls were made
      expect(transitionToIdle).not.toHaveBeenCalled()
      expect(sendToPools).not.toHaveBeenCalled()
      expect(core.warning).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        'Starting release resources routine...'
      ) // This is the first log
      // Check that no other info logs past the initial one were called
      expect(core.info).toHaveBeenCalledTimes(1)
    })
  })
})
