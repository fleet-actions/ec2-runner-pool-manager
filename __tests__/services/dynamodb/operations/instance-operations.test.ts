// __tests__/services/dynamodb/operations/instance-operations.test.ts
import { jest } from '@jest/globals'
import { DynamoDBClient } from '../../../../src/services/dynamodb/dynamo-db-client'
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'
import * as core from '../../../../__fixtures__/core.js'
import { UsageClassType } from '@aws-sdk/client-ec2'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { InstanceOperations } = await import(
  '../../../../src/services/dynamodb/operations/instance-operations'
)

describe('InstanceOperations', () => {
  let client: DynamoDBClient
  let instances: InstanceType<typeof InstanceOperations>
  const futureDate = new Date(Date.now() + 3600000).toISOString() // 1 hour in future
  const pastDate = new Date(Date.now() - 3600000).toISOString() // 1 hour in past

  // Setup DynamoDB Local
  beforeAll(startDb)
  beforeEach(createTables)
  afterEach(deleteTables)
  afterAll(stopDb)

  beforeEach(() => {
    jest.clearAllMocks()
    client = new DynamoDBClient('us-east-1', 'unused-table')
    instances = new InstanceOperations(client)
  })

  describe('putInstanceItem', () => {
    const id = 'i-123'
    const runId = 'run-123'
    const attributes = {
      runId: runId,
      threshold: futureDate,
      resourceClass: 'standard',
      instanceType: 't3.micro',
      usageClass: 'on-demand' as UsageClassType,
      state: 'idle' as const
    }
    beforeEach(async () => {
      // put one item (must be new)
      await instances.putInstanceItem(id, { ...attributes }, true)
    })

    it('should put a new instance successfully', async () => {
      // Verify instance was created by retrieving it
      const instances1 = await instances.getInstancesByRunId(runId)
      expect(instances1.length).toBe(1)
    })

    it('should fail when trying to create a duplicate with itemMustBeNew=true', async () => {
      // putting the same id should fail
      const result = await instances.putInstanceItem(
        id,
        { ...attributes, resourceClass: 'non-existent' },
        true
      )
      expect(result).toBe(false)

      // still have one item
      const instances1 = await instances.getInstancesByRunId(runId)
      expect(instances1.length).toBe(1)

      // that item should not be affected (still original attributes)
      const instance = instances1[0]
      expect(instance).toMatchObject(attributes)
    })

    it('should pass when trying to create a duplicate with itemMustBeNew=false', async () => {
      const result = await instances.putInstanceItem(id, attributes, false)
      expect(result).toBe(true)

      // still have one item
      const instances1 = await instances.getInstancesByRunId(runId)
      expect(instances1.length).toBe(1)
    })

    it('should override existing items with itemMustBeNew=false', async () => {
      // putting the same id be ok
      const newAttributes = {
        ...attributes,
        resouceClass: 'some-other-value',
        instanceType: 'some.other.type'
      }
      const result = await instances.putInstanceItem(
        id,
        { ...newAttributes },
        false
      )
      expect(result).toBe(true)

      // still have one item
      const instances1 = await instances.getInstancesByRunId(runId)
      expect(instances1.length).toBe(1)

      // that item should have the new attributes
      const instance = instances1[0]
      expect(instance).toMatchObject(newAttributes)
      expect(instance).not.toMatchObject(attributes)
    })
  })

  describe('instanceCreatedRegistration', () => {
    it('should successfully register a new instance as created', async () => {
      const result = await instances.instanceCreatedRegistration({
        id: 'i-new-created',
        runId: 'run-created',
        threshold: futureDate,
        resourceClass: 'premium',
        instanceType: 't3.large',
        usageClass: 'on-demand'
      })

      expect(result).toBe(true)

      // Verify instance was created with correct attributes
      const createdInstances =
        await instances.getInstancesByRunId('run-created')
      expect(createdInstances.length).toBe(1)
      expect(createdInstances[0].identifier).toBe('i-new-created')
      expect(createdInstances[0].state).toBe('created')
      expect(createdInstances[0].resourceClass).toBe('premium')
      expect(createdInstances[0].instanceType).toBe('t3.large')
    })

    it('should fail to register a duplicate instance', async () => {
      // Register first instance
      await instances.instanceCreatedRegistration({
        id: 'i-duplicate',
        runId: 'run-dup',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        usageClass: 'on-demand'
      })

      // Try to register the same instance again
      const result = await instances.instanceCreatedRegistration({
        id: 'i-duplicate',
        runId: 'run-dup-2', // Different run ID
        threshold: futureDate,
        resourceClass: 'premium',
        instanceType: 't3.large',
        usageClass: 'on-demand'
      })

      expect(result).toBe(false)

      // Verify original instance attributes remain unchanged
      const instances1 = await instances.getInstancesByRunId('run-dup')
      expect(instances1.length).toBe(1)
      expect(instances1[0].resourceClass).toBe('standard')
      expect(instances1[0].instanceType).toBe('t3.micro')

      // Verify no instance was created with the second run ID
      const instances2 = await instances.getInstancesByRunId('run-dup-2')
      expect(instances2.length).toBe(0)
    })
  })

  describe('instanceRunningRegistration', () => {
    beforeEach(async () => {
      // Create an instance in 'created' state to transition
      await instances.instanceCreatedRegistration({
        id: 'i-to-run',
        runId: 'run-transition',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        usageClass: 'on-demand'
      })
    })

    it('should successfully transition instance from created to running', async () => {
      const result = await instances.instanceRunningRegistration({
        id: 'i-to-run',
        runId: 'run-transition',
        threshold: futureDate
      })

      expect(result).toBe(true)

      // Verify instance state was updated
      const runningInstances =
        await instances.getInstancesByRunId('run-transition')
      expect(runningInstances.length).toBe(1)
      expect(runningInstances[0].state).toBe('running')
    })

    it('should fail when trying to transition non-existent instance', async () => {
      await expect(
        instances.instanceRunningRegistration({
          id: 'i-nonexistent',
          runId: 'run-transition',
          threshold: futureDate
        })
      ).rejects.toThrow()
    })

    it('should fail when trying to transition with incorrect runId', async () => {
      await expect(
        instances.instanceRunningRegistration({
          id: 'i-to-run',
          runId: 'wrong-run-id',
          threshold: futureDate
        })
      ).rejects.toThrow()

      // Verify instance state was not changed
      const createdInstances =
        await instances.getInstancesByRunId('run-transition')
      expect(createdInstances.length).toBe(1)
      expect(createdInstances[0].state).toBe('created')
    })
  })

  describe('expireInstance', () => {
    beforeEach(async () => {
      // Create an active instance to expire
      await instances.putInstanceItem(
        'i-to-expire',
        {
          runId: 'run-expire',
          threshold: futureDate,
          resourceClass: 'standard',
          instanceType: 't3.micro',
          state: 'running',
          usageClass: 'on-demand'
        },
        true
      )
    })

    it('should expire an instance with specified state', async () => {
      await instances.expireInstance({
        id: 'i-to-expire',
        runId: 'run-expire',
        state: 'running'
      })

      // Verify instance is now expired (threshold < now)
      const expiredInstances = await instances.getExpiredInstancesByStates([
        'running'
      ])
      expect(expiredInstances.some((i) => i.identifier === 'i-to-expire')).toBe(
        true
      )
    })

    it('should expire an instance without specifying state', async () => {
      await instances.expireInstance({
        id: 'i-to-expire',
        runId: 'run-expire',
        state: null
      })

      // Verify instance is now expired
      const expiredInstances = await instances.getExpiredInstancesByStates([
        'running'
      ])
      expect(expiredInstances.some((i) => i.identifier === 'i-to-expire')).toBe(
        true
      )
    })

    it('should fail when trying to expire with incorrect runId', async () => {
      await expect(
        instances.expireInstance({
          id: 'i-to-expire',
          runId: 'wrong-run-id',
          state: 'running'
        })
      ).rejects.toThrow()

      // Verify instance was not expired
      const expiredInstances = await instances.getExpiredInstancesByStates([
        'running'
      ])
      expect(expiredInstances.some((i) => i.identifier === 'i-to-expire')).toBe(
        false
      )
    })

    it('should fail when trying to expire with incorrect state', async () => {
      await expect(
        instances.expireInstance({
          id: 'i-to-expire',
          runId: 'run-expire',
          state: 'idle' // wrong state, actual is 'running'
        })
      ).rejects.toThrow()

      // Verify instance was not expired
      const expiredInstances = await instances.getExpiredInstancesByStates([
        'running'
      ])
      expect(expiredInstances.some((i) => i.identifier === 'i-to-expire')).toBe(
        false
      )
    })
  })

  describe('instanceStateTransition', () => {
    // test:
    // - expired-only transitions
    // - unexpired-only transitions
    // - empty runId transitions (to and from - ie: 'run-123' -> '' vice-versa)
    // - test failures
    beforeEach(async () => {
      // Register test instances as created
      // Create active instance with future threshold
      await instances.putInstanceItem(
        'i-active',
        {
          runId: 'run-123',
          threshold: futureDate,
          resourceClass: 'standard',
          instanceType: 't3.micro',
          state: 'running',
          usageClass: 'on-demand'
        },
        true
      )

      // Create expired instance with past threshold
      await instances.putInstanceItem(
        'i-expired',
        {
          runId: 'run-456',
          threshold: pastDate,
          resourceClass: 'standard',
          instanceType: 't3.micro',
          state: 'running',
          usageClass: 'on-demand'
        },
        true
      )
    })

    describe('with expiration conditions', () => {
      describe('when conditionSelectsUnexpired=true', () => {
        it('should transition unexpired instance successfully', async () => {
          await instances.instanceStateTransition({
            id: 'i-active',
            expectedRunID: 'run-123',
            newRunID: 'run-new',
            expectedState: 'running',
            newState: 'claimed',
            newThreshold: futureDate,
            conditionSelectsUnexpired: true
          })

          // Verify state transition
          const instances1 = await instances.getInstancesByRunId('run-new')
          expect(instances1.length).toBe(1)
          expect(instances1[0].state).toBe('claimed')
        })

        it('should fail to transition expired instance', async () => {
          await expect(
            instances.instanceStateTransition({
              id: 'i-expired',
              expectedRunID: 'run-456',
              newRunID: 'run-new',
              expectedState: 'running',
              newState: 'claimed',
              newThreshold: futureDate,
              conditionSelectsUnexpired: true
            })
          ).rejects.toThrow()
        })
      })

      describe('when conditionSelectsUnexpired=false', () => {
        it('should transition expired instance successfully', async () => {
          await instances.instanceStateTransition({
            id: 'i-expired',
            expectedRunID: 'run-456',
            newRunID: 'run-new',
            expectedState: 'running',
            newState: 'idle',
            newThreshold: futureDate,
            conditionSelectsUnexpired: false
          })

          // Verify state transition
          const instances1 = await instances.getInstancesByRunId('run-new')
          expect(instances1.length).toBe(1)
          expect(instances1[0].state).toBe('idle')
        })

        it('should fail transition on non-expired instance', async () => {
          await expect(
            instances.instanceStateTransition({
              id: 'i-active', // <--- should error on presumably un-expired instances
              expectedRunID: 'run-123',
              newRunID: 'run-new',
              expectedState: 'running',
              newState: 'idle',
              newThreshold: futureDate,
              conditionSelectsUnexpired: false
            })
          ).rejects.toThrow()
        })
      })
    })

    describe('with runId isolation', () => {
      it('should fail transition when using incorrect runId', async () => {
        // Try to transition with wrong runId
        await expect(
          instances.instanceStateTransition({
            id: 'i-active',
            expectedRunID: 'wrong-run-id', // Incorrect runId
            newRunID: 'run-new',
            expectedState: 'running',
            newState: 'claimed',
            newThreshold: futureDate,
            conditionSelectsUnexpired: true
          })
        ).rejects.toThrow()

        // Verify instance still belongs to original runId
        const originalInstances = await instances.getInstancesByRunId('run-123')
        expect(originalInstances.length).toBe(1)
        expect(originalInstances[0].identifier).toBe('i-active')
        expect(originalInstances[0].state).toBe('running')
      })
    })

    describe('with empty runId values', () => {
      it('should transition to empty runId (termination scenario)', async () => {
        await instances.instanceStateTransition({
          id: 'i-active',
          expectedRunID: 'run-123',
          newRunID: '', // Empty new runId
          expectedState: 'running',
          newState: 'terminated',
          newThreshold: '',
          conditionSelectsUnexpired: true
        })

        // Verify instance no longer belongs to original runId
        const originalInstances = await instances.getInstancesByRunId('run-123')
        expect(originalInstances.length).toBe(0)
      })

      it('should transition from empty runId to non-empty runId (provisioning scenario)', async () => {
        const localRunId = 'run-local'
        // First create an instance with empty runId
        await instances.putInstanceItem(
          'i-idle-to-claimed',
          {
            runId: '',
            threshold: futureDate,
            resourceClass: 'standard',
            instanceType: 't3.micro',
            state: 'idle',
            usageClass: 'on-demand'
          },
          true
        )

        // Verify instance now belongs to new runId
        let myInstances = await instances.getInstancesByRunId('')
        expect(myInstances.length).toBe(1)
        expect(myInstances[0].identifier).toBe('i-idle-to-claimed')
        expect(myInstances[0].state).toBe('idle')

        // Transition from empty to non-empty runId
        await instances.instanceStateTransition({
          id: 'i-idle-to-claimed',
          expectedRunID: '', // Empty expected runId
          newRunID: localRunId,
          expectedState: 'idle',
          newState: 'claimed',
          newThreshold: futureDate,
          conditionSelectsUnexpired: true
        })

        // Verify instance now belongs to new runId
        myInstances = await instances.getInstancesByRunId(localRunId)
        expect(myInstances.length).toBe(1)
        expect(myInstances[0].identifier).toBe('i-idle-to-claimed')
        expect(myInstances[0].state).toBe('claimed')
      })
    })

    describe('with error condition failures', () => {
      it('should report state mismatch with correct emoji', async () => {
        // Try to transition with wrong state
        await expect(
          instances.instanceStateTransition({
            id: 'i-active',
            expectedRunID: 'run-123',
            newRunID: 'run-new',
            expectedState: 'idle', // Wrong state - actual is 'running'
            newState: 'claimed',
            newThreshold: futureDate,
            conditionSelectsUnexpired: true
          })
        ).rejects.toThrow()

        // Verify warning message includes the state mismatch emoji
        expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/📝/))
      })

      it('should report threshold condition failure with correct emoji', async () => {
        // Try to transition with wrong expiration condition
        await expect(
          instances.instanceStateTransition({
            id: 'i-expired',
            expectedRunID: 'run-456',
            newRunID: 'run-new',
            expectedState: 'running',
            newState: 'claimed',
            newThreshold: futureDate,
            conditionSelectsUnexpired: true // Wrong - trying to select unexpired but instance is expired
          })
        ).rejects.toThrow()

        // Verify warning message includes the threshold emoji
        expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/⌛️/))
      })

      it('should report runId mismatch with correct emoji', async () => {
        // Try to transition with wrong runId
        await expect(
          instances.instanceStateTransition({
            id: 'i-active',
            expectedRunID: 'wrong-run-id', // Wrong runId
            newRunID: 'run-new',
            expectedState: 'running',
            newState: 'claimed',
            newThreshold: futureDate,
            conditionSelectsUnexpired: true
          })
        ).rejects.toThrow()

        // Verify warning message includes the runId mismatch emoji
        expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/🏃/))
      })
    })
  })

  describe('getExpiredInstancesByStates', () => {
    beforeEach(async () => {
      // Create instances with various states and thresholds
      await instances.putInstanceItem('i-expired-running', {
        runId: 'run-test',
        threshold: pastDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'running',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-expired-idle', {
        runId: 'run-test',
        threshold: pastDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-active-running', {
        runId: 'run-test',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'running',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-terminated', {
        runId: '',
        threshold: '',
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'terminated',
        usageClass: 'on-demand'
      })
    })

    it('should retrieve expired instances by specific states', async () => {
      const expiredRunning = await instances.getExpiredInstancesByStates([
        'running'
      ])
      expect(expiredRunning.length).toBe(1)
      expect(expiredRunning[0].identifier).toBe('i-expired-running')

      const expiredMultiState = await instances.getExpiredInstancesByStates([
        'running',
        'idle'
      ])
      expect(expiredMultiState.length).toBe(2)

      const noExpiredClaimed = await instances.getExpiredInstancesByStates([
        'claimed'
      ])
      expect(noExpiredClaimed.length).toBe(0)
    })

    it('should not retrieve instances with empty thresholds', async () => {
      // NOTE: See before each - only one registered with no threshold is the terminated one
      const noThreshold = await instances.getExpiredInstancesByStates([
        'running',
        'idle',
        'claimed',
        'terminated'
      ])

      // Verify that instances with empty thresholds aren't included
      expect(noThreshold.every((instance) => instance.threshold !== '')).toBe(
        true
      )
      expect(
        noThreshold.find((instance) => instance.identifier === 'i-terminated')
      ).toBeUndefined()

      // Only the instances with actual past dates should be returned
      expect(noThreshold.length).toBe(2)
      expect(noThreshold.map((i) => i.identifier).sort()).toEqual(
        ['i-expired-running', 'i-expired-idle'].sort()
      )
    })
  })

  describe('deleteValues', () => {
    beforeEach(async () => {
      // Create instances
      await instances.putInstanceItem('i-del1', {
        runId: 'run-del',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-del2', {
        runId: 'run-del',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-del3', {
        runId: 'run-other',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })
    })

    it('should delete multiple instances - runId not enforced when not provided', async () => {
      // Delete without runId check
      const result = await instances.deleteInstanceItems(['i-del1', 'i-del2'])

      // All operations should be fulfilled
      expect(result.every((r) => r.status === 'fulfilled')).toBe(true)

      // Verify instances are gone
      const remaining = await instances.getInstancesByRunId('run-del')
      expect(remaining.length).toBe(0)
    })

    it('should enforce runId isolation when provided', async () => {
      // Try to delete with incorrect runId
      const result = await instances.deleteInstanceItems(
        ['i-del3'],
        'wrong-run'
      )

      // Operation should be rejected
      expect(result[0].status).toBe('rejected')

      // Verify instance still exists
      const remaining = await instances.getInstancesByRunId('run-other')
      expect(remaining.length).toBe(1)
    })
  })

  describe('getInstancesByRunId', () => {
    beforeEach(async () => {
      // Create instances with different runIds
      await instances.putInstanceItem('i-run1-1', {
        runId: 'run-111',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'running',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-run1-2', {
        runId: 'run-111',
        threshold: futureDate,
        resourceClass: 'premium',
        instanceType: 't3.large',
        state: 'running',
        usageClass: 'on-demand'
      })

      await instances.putInstanceItem('i-run2', {
        runId: 'run-222',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })
    })

    it('should retrieve instances by runId', async () => {
      const run1Instances = await instances.getInstancesByRunId('run-111')
      expect(run1Instances.length).toBe(2)

      const run2Instances = await instances.getInstancesByRunId('run-222')
      expect(run2Instances.length).toBe(1)
      expect(run2Instances[0].state).toBe('idle')
    })

    it("should retrieve on empty run ids ('')", async () => {
      const id = 'i-empty-runid'
      await instances.putInstanceItem('i-empty-runid', {
        runId: '',
        threshold: futureDate,
        resourceClass: 'standard',
        instanceType: 't3.micro',
        state: 'idle',
        usageClass: 'on-demand'
      })

      const emptyRun = await instances.getInstancesByRunId('')
      expect(emptyRun.length).toBe(1)
      expect(emptyRun[0].identifier).toBe(id)
    })

    it('should not retrieve anything on non-existent runIds', async () => {
      const nonExistentRun = await instances.getInstancesByRunId('non-existent')
      expect(nonExistentRun.length).toBe(0)
    })
  })
})
