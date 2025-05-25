// __tests__/services/dynamodb/operations/signal-operations.test.ts
import { jest } from '@jest/globals'
import { DynamoDBClient } from '../../../../src/services/dynamodb/dynamo-db-client'
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'
import * as core from '../../../../__fixtures__/core.js'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { WorkerSignalOperations } = await import(
  '../../../../src/services/dynamodb/operations/signal-operations'
)

describe('WorkerSignalOperations', () => {
  let client: DynamoDBClient
  let signal: InstanceType<typeof WorkerSignalOperations>

  // Setup DynamoDB Local
  beforeAll(startDb)
  beforeEach(createTables)
  afterEach(deleteTables)
  afterAll(stopDb)

  beforeEach(() => {
    jest.clearAllMocks()
    client = new DynamoDBClient('us-east-1', 'main-table', 'testing-table')
    signal = new WorkerSignalOperations(client)
  })

  describe('singleCompletedOnSignal', () => {
    it('should return retry when no signal record exists', async () => {
      const result = await signal.singleCompletedOnSignal(
        'i-missing',
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('retry')
    })

    it('should return success when signal matches runId', async () => {
      // Add test signal with matching runId
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-success'
      )

      const result = await signal.singleCompletedOnSignal(
        'i-success',
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('success')
    })

    it('should return failed when failed signal matches runId', async () => {
      // Add test with failed signal
      await signal.updateValue(
        {
          state: WorkerSignalOperations.FAILED_STATUS.UD_REG,
          runId: 'run-123'
        },
        'i-failed'
      )

      const result = await signal.singleCompletedOnSignal(
        'i-failed',
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('failed')
    })

    it('should return retry when runId does not match', async () => {
      // Add test with wrong runId
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'wrong-run' },
        'i-wrong-run'
      )

      const result = await signal.singleCompletedOnSignal(
        'i-wrong-run',
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('retry')
    })

    it('should throw error for invalid signal', async () => {
      await expect(
        signal.singleCompletedOnSignal('i-test', 'run-123', 'INVALID_SIGNAL')
      ).rejects.toThrow('Signal INVALID_SIGNAL is not a valid signal')
    })

    it('should return retry when signal state does not match expected signal', async () => {
      // Add test with correct runId but wrong signal state
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD, runId: 'run-123' },
        'i-wrong-state'
      )

      const result = await signal.singleCompletedOnSignal(
        'i-wrong-state',
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('retry')
    })
  })

  describe('allCompletedOnSignal', () => {
    it('should return success when all instances have matching signal and runId', async () => {
      // Setup multiple instances with matching signals
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-1'
      )
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-2'
      )

      const result = await signal.allCompletedOnSignal(
        ['i-1', 'i-2'],
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('success')
    })

    it('should return failed when any instance has a failed signal', async () => {
      // One success, one failure
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-ok'
      )
      await signal.updateValue(
        {
          state: WorkerSignalOperations.FAILED_STATUS.UD_REG,
          runId: 'run-123'
        },
        'i-fail'
      )

      const result = await signal.allCompletedOnSignal(
        ['i-ok', 'i-fail'],
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('failed')
    })

    it('should return retry when some instances are missing', async () => {
      // Only one exists
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-exists'
      )

      const result = await signal.allCompletedOnSignal(
        ['i-exists', 'i-missing'],
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('retry')
    })

    it('should handle mixed states with matching runIds', async () => {
      // Two different OK states with matching runIds
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD, runId: 'run-123' },
        'i-ud'
      )
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-ud-reg'
      )

      // Looking for UD_REG specifically
      const result = await signal.allCompletedOnSignal(
        ['i-ud', 'i-ud-reg'],
        'run-123',
        WorkerSignalOperations.OK_STATUS.UD_REG
      )
      expect(result).toBe('retry') // Not all instances have the specific signal
    })

    it('should handle empty instance array', async () => {
      await expect(
        signal.allCompletedOnSignal(
          [],
          'run-123',
          WorkerSignalOperations.OK_STATUS.UD_REG
        )
      ).rejects.toThrow() // Should throw as there's no instances to check
    })
  })

  describe('pollOnSignal', () => {
    it('should return success when all instances complete successfully', async () => {
      // Add successful signals
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-poll-1'
      )
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-poll-2'
      )

      const result = await signal.pollOnSignal({
        instanceIds: ['i-poll-1', 'i-poll-2'],
        runId: 'run-123',
        signal: WorkerSignalOperations.OK_STATUS.UD_REG,
        timeoutSeconds: 0.5,
        intervalSeconds: 0.1
      })

      expect(result.state).toBe(true)
      expect(result.message).toContain('🎉')
    })

    it('should timeout when instances never complete', async () => {
      const result = await signal.pollOnSignal({
        instanceIds: ['i-missing'],
        runId: 'run-123',
        signal: WorkerSignalOperations.OK_STATUS.UD_REG,
        timeoutSeconds: 0.5,
        intervalSeconds: 0.1
      })

      expect(result.state).toBe(false)
      expect(result.message).toContain('⌛️')
    })

    it('should return failure when an instance fails', async () => {
      await signal.updateValue(
        {
          state: WorkerSignalOperations.FAILED_STATUS.UD_REG,
          runId: 'run-123'
        },
        'i-fail'
      )

      const result = await signal.pollOnSignal({
        instanceIds: ['i-fail'],
        runId: 'run-123',
        signal: WorkerSignalOperations.OK_STATUS.UD_REG,
        timeoutSeconds: 0.5,
        intervalSeconds: 0.1
      })

      expect(result.state).toBe(false)
    })

    it('should handle single instance case properly', async () => {
      // Add successful signal for single instance
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-single'
      )

      const result = await signal.pollOnSignal({
        instanceIds: ['i-single'],
        runId: 'run-123',
        signal: WorkerSignalOperations.OK_STATUS.UD_REG,
        timeoutSeconds: 0.5,
        intervalSeconds: 0.1
      })

      expect(result.state).toBe(true)
      expect(result.message).toContain('🎉')
    })

    it('should fail when given an empty array of instance IDs', async () => {
      const result = await signal.pollOnSignal({
        instanceIds: [], // Empty array
        runId: 'run-123',
        signal: WorkerSignalOperations.OK_STATUS.UD_REG,
        timeoutSeconds: 0.5,
        intervalSeconds: 0.1
      })

      expect(result.state).toBe(false)
      expect(result.message).toContain('Received no instances to poll')
    })
  })

  describe('buildSignalReport', () => {
    it('should correctly categorize instances by state', async () => {
      // Setup various signal states
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'run-123' },
        'i-match'
      )
      await signal.updateValue(
        { state: WorkerSignalOperations.OK_STATUS.UD_REG, runId: 'wrong-run' },
        'i-wrong-run'
      )

      // Get values to pass to buildSignalReport
      const ids = ['i-match', 'i-wrong-run', 'i-missing']
      const values = await signal.getValues(ids)

      // Call private method using bracket notation
      const report = signal['buildSignalReport'](ids, values, 'run-123')

      expect(report.missing).toContain('i-missing')
      expect(
        report.matchingIds[WorkerSignalOperations.OK_STATUS.UD_REG]
      ).toContain('i-match')
      expect(
        report.nonMatchingIds[WorkerSignalOperations.OK_STATUS.UD_REG].length
      ).toBe(1)
      expect(
        report.nonMatchingIds[WorkerSignalOperations.OK_STATUS.UD_REG][0]
          .instanceId
      ).toBe('i-wrong-run')
    })
  })

  describe('error handling', () => {
    it('should handle invalid signal parameters', async () => {
      await expect(
        signal.pollOnSignal({
          instanceIds: ['i-test'],
          runId: 'run-123',
          signal: 'INVALID_SIGNAL',
          timeoutSeconds: 0.5,
          intervalSeconds: 0.1
        })
      ).resolves.toEqual(
        expect.objectContaining({
          state: false,
          message: expect.stringContaining('not a valid signal')
        })
      )
    })
  })
})
