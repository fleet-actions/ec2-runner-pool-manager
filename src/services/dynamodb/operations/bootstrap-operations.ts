import * as core from '@actions/core'
import { DynamoDBClient } from '../dynamo-db-client.js'
import { BasicValueOperations } from './basic-operations.js'
import { createWaiter, WaiterState, WaiterResult } from '@smithy/util-waiter'

// USAGE:
// To leverage getValue, will need to provide an input. OTHERWISE will error OUT!!
// .example (await getValue("id-123"))

interface InstanceStates {
  unpolled: string[]
  missing: string[]
  udComplete: string[]
  udRegComplete: string[]
}

export class BootstrapOperations extends BasicValueOperations<string> {
  // state transitions:
  // unpolled (registerd for tracking, but not ddb polled)
  // -> missing (polled, but item not present)
  // -> udcompleted (polled, ud completed, not registered yet)
  // -> udregcompleted (polled, ud-reg-completed ✅)
  static readonly STATUS = {
    USERDATA_COMPLETED: 'USERDATA_COMPLETED',
    USERDATA_REGISTRATION_COMPLETED: 'USERDATA_REGISTRATION_COMPLETED'
  }
  static readonly ENTITY_TYPE = 'BOOTSTRAP'

  public _totalInstanceCount = 0
  public _instanceStates: InstanceStates = {
    unpolled: [],
    missing: [],
    udComplete: [],
    udRegComplete: []
  }

  constructor(client: DynamoDBClient) {
    super(BootstrapOperations.ENTITY_TYPE, null, client)
  }

  async registerInstancesForTracking(instanceIds: string[]) {
    // Reset the state and add all instances as unpolled
    core.info(
      `Bootstrap tracking: registered (${instanceIds.length}) of instances; ids: (${instanceIds})`
    )
    this._instanceStates = {
      unpolled: [...instanceIds],
      missing: [],
      udComplete: [],
      udRegComplete: []
    }

    this._totalInstanceCount = instanceIds.length
  }

  async areAllInstancesComplete(): Promise<boolean> {
    const states = await this.getInstanceStates()
    const incomplete = [
      ...states.unpolled,
      ...states.missing,
      ...states.udComplete
    ]
    const difference = this._totalInstanceCount - states.udRegComplete.length
    core.info(
      `Bootstrap tracking: ${states.udRegComplete.length}/${this._totalInstanceCount} are userdata-registration complete`
    )

    // NOTE: These are for logging purposes
    if (difference === 0) {
      core.info(
        'Bootstrap tracking: all instances are ud-reg-complete - yay! 🍻'
      )
    } else if (difference <= 0) {
      throw new Error(
        `Bootstrap tracking: There are more ud-reg-complete instances (${states.udRegComplete.length}) than registered (${this._totalInstanceCount}) - how?`
      )
    } else {
      core.info(
        `Bootstrap tracking: not all registered instances are ud-reg-complete: ${incomplete} - try again ♻️`
      )
    }

    return difference === 0
  }

  /**
   * Polls areAllInstancesComplete until success or timeout.
   *
   * @param timeoutSeconds Total time to wait in seconds.
   * @param intervalSeconds Interval between polls in seconds.
   */
  async areAllInstancesCompletePoll(
    instanceIds: string[],
    timeoutSeconds: number = 120,
    intervalSeconds: number = 10
  ): Promise<{ state: boolean; message: string }> {
    try {
      // register instances
      await this.registerInstancesForTracking(instanceIds)

      // 🔍 Callback to used to define validity of state
      const checkFn = async (): Promise<WaiterResult> => {
        try {
          const done = await this.areAllInstancesComplete()
          return done
            ? { state: WaiterState.SUCCESS }
            : { state: WaiterState.RETRY }
        } catch (error) {
          return { state: WaiterState.FAILURE, reason: error as Error }
        }
      }

      // create waiter
      const waiter = createWaiter(
        {
          // 🔍 Hack to fill in client field with valid aws sdk client
          client: this.client.getClient(),
          maxWaitTime: timeoutSeconds,
          minDelay: intervalSeconds,
          maxDelay: intervalSeconds
        },
        checkFn,
        async (_client, check) => check()
      )

      // await on waiter
      const result: WaiterResult = await waiter

      if (result.state === WaiterState.SUCCESS) {
        return {
          state: true,
          message: 'All instances are userdata-registration complete 🎉'
        }
      } else if (result.state === WaiterState.TIMEOUT) {
        return {
          state: false,
          message: `Timed out after ${timeoutSeconds} seconds waiting for instances to complete ⌛️`
        }
      } else if (result.state === WaiterState.FAILURE) {
        return {
          state: false,
          message:
            result.reason?.message ||
            'Failed to check instance completion status'
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

  //
  //
  // PRIVATE METHODS
  //
  //

  private async refreshInstanceStates(): Promise<void> {
    if (this._totalInstanceCount === 0)
      throw new Error(
        'Bootstrap tracking: cannot get bootstrap states, there are no instances registered to track'
      )
    // Only poll instances that need polling (unpolled + ones not in udRegComplete)
    const instancesNeedingUpdate = [
      ...this._instanceStates.unpolled,
      ...this._instanceStates.missing,
      ...this._instanceStates.udComplete
    ]

    if (instancesNeedingUpdate.length === 0) {
      core.info('Bootstrap tracking: no instances need re-tracking')
      core.info(`See all ready instances ${this._instanceStates.udRegComplete}`)
      return
    }

    // Get values for instances that need updating
    core.info(`Bootstrap tracking: tracking: ${instancesNeedingUpdate}`)
    const states = await this.getValues(instancesNeedingUpdate)

    // Create new state object (will replace the old one)
    const newStates: InstanceStates = {
      unpolled: [],
      missing: [],
      udComplete: [],
      udRegComplete: [...this._instanceStates.udRegComplete] // Keep existing completed instances
    }

    // Categorize each instance based on its state
    instancesNeedingUpdate.forEach((id, index) => {
      const state = states[index]

      if (state === null) {
        core.info(`Bootstrap tracking: missing - ${id}`)
        newStates.missing.push(id)
      } else if (state === BootstrapOperations.STATUS.USERDATA_COMPLETED) {
        core.info(`Bootstrap tracking: ud complete - ${id}`)
        newStates.udComplete.push(id)
      } else if (
        state === BootstrapOperations.STATUS.USERDATA_REGISTRATION_COMPLETED
      ) {
        core.info(`Bootstrap tracking: ud-reg complete - ${id}`)
        newStates.udRegComplete.push(id)
      }
    })

    // 🔍 Detailed logging
    core.info(
      `Bootstrap tracking: FOUND STATE\n` +
        `- unpolled: ${newStates.unpolled.join(', ') || 'none'}\n` +
        `- missing: ${newStates.missing.join(', ') || 'none'}\n` +
        `- ud-complete: ${newStates.udComplete.join(', ') || 'none'}\n` +
        `- ud-reg-complete: ${newStates.udRegComplete.join(', ') || 'none'}`
    )

    // Update the instance states
    this._instanceStates = newStates
  }

  private async getInstanceStates(): Promise<InstanceStates> {
    await this.refreshInstanceStates()
    return { ...this._instanceStates }
  }
}
