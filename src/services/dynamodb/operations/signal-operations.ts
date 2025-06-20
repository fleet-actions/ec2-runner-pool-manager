import * as core from '@actions/core'
import { createWaiter, WaiterState, WaiterResult } from '@smithy/util-waiter'
import { DynamoDBClient } from '../dynamo-db-client.js'
import { BasicValueOperations } from './basic-operations.js'

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

export interface PollOnSignalInputs {
  instanceIds: string[]
  runId: string
  signal: string
  timeoutSeconds: number
  intervalSeconds: number
}

export type Status = 'success' | 'failed' | 'retry'

// Will appear as { "PK": "TYPE#WS", "SK": "i-123", value: { state: "...", runId: "..." } }
export class WorkerSignalOperations extends BasicValueOperations<WorkerSignalValue> {
  static readonly ENTITY_TYPE = 'WS'
  static readonly OK_STATUS = {
    UD: 'UD_OK',
    UD_REG: 'UD_REG_OK',
    UD_REMOVE_REG: 'UD_REMOVE_REG_OK', // config dereg
    UD_REMOVE_REG_REMOVE_RUN: 'UD_REMOVE_REG_REMOVE_RUN_OK' // release
  }

  static readonly FAILED_STATUS = {
    UD: 'UD_FAILED',
    UD_REG: 'UD_REG_FAILED',
    UD_REMOVE_REG: 'UD_REMOVE_REG_FAILED',
    UD_REMOVE_REG_REMOVE_RUN: 'UD_REMOVE_REG_REMOVE_RUN_FAILED'
  }

  constructor(client: DynamoDBClient) {
    super(WorkerSignalOperations.ENTITY_TYPE, null, client)
  }

  // Checks if a single instance has completed with the expected signal
  async singleCompletedOnSignal(
    id: string,
    runId: string,
    signal: string
  ): Promise<Status> {
    core.debug(
      `Checking signal for instance ${id} with runId: ${runId}, signal: ${signal}`
    )

    // Validate the demanded signal
    const allStatuses = [
      ...Object.values(WorkerSignalOperations.OK_STATUS),
      ...Object.values(WorkerSignalOperations.FAILED_STATUS)
    ]
    if (!allStatuses.includes(signal)) {
      core.warning(
        `Signal ${signal} is not a valid signal to look for. Valid signals: ${allStatuses.join(', ')}`
      )
      throw new Error(`Signal ${signal} is not a valid signal`)
    }

    // Get the single value
    const value = await this.getValue(id)

    // Log the state
    if (!value) {
      core.info(`Instance ${id}: No signal record found`)
      return 'retry'
    }

    core.debug(
      `Instance ${id} current state: ${value.state}, runId: ${value.runId}`
    )

    // Check for failure states
    if (
      Object.values(WorkerSignalOperations.FAILED_STATUS).includes(
        value.state
      ) &&
      value.runId === runId
    ) {
      core.info(
        `Instance ${id}: Failed with state ${value.state} for runId ${runId}`
      )
      return 'failed'
    }

    // Check for success
    if (value.state === signal && value.runId === runId) {
      core.info(
        `Instance ${id}: Successfully completed with signal ${signal} for runId ${runId}`
      )
      return 'success'
    }

    // Any other case is a retry
    core.info(
      `Instance ${id}: Waiting for signal ${signal} (current: ${value.state}) with runId ${runId} (current: ${value.runId})`
    )
    return 'retry'
  }

  // Convenience method to see if either UD or UD_REG (not restricted to UD only)
  async allCompletedOnSignal(
    ids: string[],
    runId: string,
    signal: string
  ): Promise<Status> {
    core.debug(`Received: ids ${ids}; runId: ${runId}, signal: ${signal}`)

    if (ids.length === 0) {
      throw new Error('There are no instances/ids to look for a signal')
    }

    // first, validate the demanded signal
    const allStatuses = [
      ...Object.values(WorkerSignalOperations.OK_STATUS),
      ...Object.values(WorkerSignalOperations.FAILED_STATUS)
    ]
    if (!allStatuses.includes(signal)) {
      core.warning(
        `Signal ${signal} is not a valid signal to look for. See valid signas ${allStatuses}. Throwing error...`
      )
      throw new Error(`Signal ${signal} is not a valid signal...`)
    }

    const values = await this.getValues(ids)
    core.debug(`Received ws values: ${JSON.stringify(values, null, 2)}`)
    const report = this.buildSignalReport(ids, values, runId)
    core.debug(`Received ws signal report: ${JSON.stringify(report, null, 2)}`)

    // Given runId, if any failed staus is found - mark for failure
    const hasAnyFailures = Object.values(
      WorkerSignalOperations.FAILED_STATUS
    ).some((failedStatus) => {
      const ary = report.matchingIds[failedStatus]
      if (!ary)
        throw new Error(
          `ERROR: ${failedStatus} may be an invalid state. Ary (${ary}) is not an valid array`
        )
      return ary.length > 0
    })

    if (hasAnyFailures) {
      return 'failed'
    }

    // Success conditions:
    // 1. All instances have the demanded signal state with matching runId
    // 2. None are missing
    const s = signal
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
  async pollOnSignal(
    inputs: PollOnSignalInputs
  ): Promise<{ state: boolean; message: string }> {
    try {
      // Callback to check completion status
      const { instanceIds, runId, signal, timeoutSeconds, intervalSeconds } =
        inputs
      const checkFn = async (): Promise<WaiterResult> => {
        try {
          let result: Status

          if (instanceIds.length <= 0) {
            return {
              state: WaiterState.FAILURE,
              reason: new Error('Received no instances to poll')
            }
          } else if (instanceIds.length === 1) {
            result = await this.singleCompletedOnSignal(
              instanceIds[0],
              runId,
              signal
            )
          } else {
            result = await this.allCompletedOnSignal(instanceIds, runId, signal)
          }

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

    const statusArray: string[] = [
      ...Object.values(WorkerSignalOperations.OK_STATUS),
      ...Object.values(WorkerSignalOperations.FAILED_STATUS)
    ]
    statusArray.forEach((status) => {
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
