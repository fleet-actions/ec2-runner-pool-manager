import * as core from '@actions/core'
import { createWaiter, WaiterState, WaiterResult } from '@smithy/util-waiter'
import { DynamoDBClient } from '../dynamo-db-client.js'
import { BasicValueOperations } from './basic-operations.js'

export interface SendSignalInputs {
  instanceId: string
  runId: string
}

// Will appear as { "PK": "TYPE#LS", "SK": "i-123", value: "run-123" }
export class LeaderSignalOperations extends BasicValueOperations<string> {
  static readonly ENTITY_TYPE = 'LS'
  constructor(client: DynamoDBClient) {
    super(LeaderSignalOperations.ENTITY_TYPE, null, client)
  }

  async sendSignal(inputs: SendSignalInputs) {
    const { runId, instanceId } = inputs
    // note: instanceId is SK
    await this.updateValue(runId, instanceId)
  }
}

export interface WorkerSignalValue {
  runId: string
  state: string
}

interface SignalReport {
  missing: string[]
  matchingIds: Record<string, string[]>
  nonMatchingIds: Record<
    string,
    Array<{ instanceId: string; actualRunId: string }>
  >
}

export type Signals = 'success' | 'failed' | 'retry'

// Will appear as { "PK": "TYPE#WS", "SK": "i-123", value: { state: "...", runId: "..." } }
export class WorkerSignalOperations extends BasicValueOperations<WorkerSignalValue> {
  static readonly ENTITY_TYPE = 'WS'
  static readonly OK_STATUS = {
    UD: 'UD_OK',
    UD_REG: 'UD_REG_OK'
  }

  static readonly FAILED_STATUS = {
    UD: 'UD_FAILED',
    UD_REG: 'UD_REG_FAILED'
  }

  // Convenience method to see if either UD or UD_REG (not restricted to UD only)
  async allCompletedUserDataAndRegistration(
    ids: string[],
    runId: string
  ): Promise<Signals> {
    const values = await this.getValues(ids)
    const report = this.buildSignalReport(ids, values, runId)

    // FAILURE MODES:
    // - ANY UD Failures
    // - If still OK; any matching id failures

    // Special Failure case:
    // Given ANY instance, if UD Failed is found - mark for failure
    const f = WorkerSignalOperations.FAILED_STATUS.UD
    const anyUDFailed = [...report.matchingIds[f], ...report.nonMatchingIds[f]]
    if (anyUDFailed.length > 0) {
      return 'failed'
    }

    // Rest of the failure cases:
    // Given runId, if any failed staus is found - mark for failure
    const hasAnyFailures = Object.values(
      WorkerSignalOperations.FAILED_STATUS
    ).some((failedStatus) => report.matchingIds[failedStatus].length > 0)

    if (hasAnyFailures) {
      return 'failed'
    }

    // Success conditions:
    // 1. All instances have UD_REG_OK state with matching runId
    // 2. None are missing
    const s = WorkerSignalOperations.OK_STATUS.UD_REG
    if (
      report.missing.length === 0 &&
      report.matchingIds[s].length === ids.length
    ) {
      return 'success'
    }

    return 'retry'
  }

  /**
   * Polls for all instances to complete userdata and registration with the given runId
   *
   * @param instanceIds List of instance IDs to check
   * @param runId The expected runId that should match
   * @param timeoutSeconds Total wait time in seconds
   * @param intervalSeconds Interval between polls in seconds
   * @returns Result object with state and message
   */
  async pollUntilAllInstancesComplete(
    instanceIds: string[],
    runId: string,
    timeoutSeconds: number = 120,
    intervalSeconds: number = 10
  ): Promise<{ state: boolean; message: string }> {
    try {
      // Callback to check completion status
      const checkFn = async (): Promise<WaiterResult> => {
        try {
          const result = await this.allCompletedUserDataAndRegistration(
            instanceIds,
            runId
          )

          if (result === 'success') {
            return { state: WaiterState.SUCCESS }
          } else if (result === 'failed') {
            return {
              state: WaiterState.FAILURE,
              reason: new Error('Some instances failed registration')
            }
          } else {
            // 'retry' case
            return { state: WaiterState.RETRY }
          }
        } catch (error) {
          return { state: WaiterState.FAILURE, reason: error as Error }
        }
      }

      // Create waiter
      const waiter = createWaiter(
        {
          // Hack to fill in client field with valid aws sdk client
          client: this.client.getClient(),
          maxWaitTime: timeoutSeconds,
          minDelay: intervalSeconds,
          maxDelay: intervalSeconds
        },
        checkFn,
        async (_client, check) => check()
      )

      // Await on waiter
      const result: WaiterResult = await waiter

      if (result.state === WaiterState.SUCCESS) {
        const final = WorkerSignalOperations.OK_STATUS.UD_REG
        return {
          state: true,
          message: `All ${instanceIds.length} instances completed ${final} ${runId} 🎉`
        }
      } else if (result.state === WaiterState.TIMEOUT) {
        return {
          state: false,
          message: `Timed out after ${timeoutSeconds} seconds waiting for instances to complete ⌛️`
        }
      } else if (result.state === WaiterState.FAILURE) {
        return {
          state: false,
          message: result.reason?.message || 'Registration process failed'
        }
      } else {
        return {
          state: false,
          message: `Unexpected waiter state: ${result.state}`
        }
      }
    } catch (error) {
      return { state: false, message: (error as Error).message }
    }
  }

  /**
   * Builds a detailed report of instance states with runId matching
   */
  private buildSignalReport(
    ids: string[],
    values: (WorkerSignalValue | null)[],
    expectedRunId: string
  ): SignalReport {
    // Initialize results structure
    const missing: string[] = []
    const matchingIds: Record<string, string[]> = {}
    const nonMatchingIds: Record<
      string,
      Array<{ instanceId: string; actualRunId: string }>
    > = {}

    // Initialize all possible states from both OK and FAILED status objects
    const allStatuses = {
      ...WorkerSignalOperations.OK_STATUS,
      ...WorkerSignalOperations.FAILED_STATUS
    }

    Object.values(allStatuses).forEach((status) => {
      matchingIds[status] = []
      nonMatchingIds[status] = []
    })

    // Categorize each instance
    ids.forEach((id, index) => {
      const value = values[index]

      if (value === null) {
        missing.push(id)
      } else {
        const state = value.state
        // Check if runId matches
        if (value.runId === expectedRunId) {
          // Add to matching IDs by state
          if (matchingIds[state]) {
            matchingIds[state].push(id)
          }
        } else {
          // Add to non-matching IDs by state
          if (nonMatchingIds[state]) {
            nonMatchingIds[state].push({
              instanceId: id,
              actualRunId: value.runId
            })
          }
        }
      }
    })

    // Log main summary with core.info
    let infoMessage = `Worker signal tracking: SUMMARY (matching runId: ${expectedRunId})\n`
    infoMessage += `- Missing: ${missing.join(', ') || 'none'}\n`

    // Only include states that have matching IDs
    Object.entries(matchingIds).forEach(([state, stateIds]) => {
      if (stateIds.length > 0) {
        infoMessage += `- ${state}: ${stateIds.join(', ')}\n`
      }
    })

    core.info(infoMessage)

    // Log non-matching details with core.debug
    let debugMessage = `Worker signal tracking: NON-MATCHING RUNID DETAILS\n`
    let hasNonMatching = false

    // Only include states that have non-matching IDs
    Object.entries(nonMatchingIds).forEach(([state, items]) => {
      if (items.length > 0) {
        hasNonMatching = true
        debugMessage += `- ${state}: ${items.map((item) => `${item.instanceId} (runId: ${item.actualRunId})`).join(', ')}\n`
      }
    })

    if (hasNonMatching) {
      core.debug(debugMessage)
    } else {
      core.debug(
        'Worker signal tracking: No instances with non-matching runIds'
      )
    }

    return { missing, matchingIds, nonMatchingIds }
  }
}
