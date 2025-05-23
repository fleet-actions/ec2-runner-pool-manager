import * as core from '@actions/core'
import { DynamoDBClient } from '../dynamo-db-client.js'
import { BasicValueOperations } from './basic-operations.js'
import { createWaiter, WaiterState, WaiterResult } from '@smithy/util-waiter'

interface InstanceHealth {
  healthy: string[]
  unhealthy: string[]
  missing: string[]
}

export class HeartbeatOperations extends BasicValueOperations<string> {
  // state transitions:
  // registered (registerd for tracking, but not ddb polled)
  // -> missing (polled, heartbeat not present)
  // -> unhealthy (polled, heartbeat outdated 😭)
  // -> udregcompleted (polled, heartbeat within window ✅)

  static readonly STATUS = {
    PING: 'PING'
  }
  static readonly ENTITY_TYPE = 'HEARTBEAT'
  static readonly PERIOD_SECONDS = 2
  static readonly HEALTHY = 'healthy'
  static readonly UNHEALTHY = 'unhealthy'
  static readonly MISSING = 'missing'

  private maxAgeMs: number
  private maxAgePeriodMultiplier: number
  private _registeredInstanceIds: string[] = []
  private _instanceHealth: InstanceHealth = {
    [HeartbeatOperations.HEALTHY]: [],
    [HeartbeatOperations.UNHEALTHY]: [],
    [HeartbeatOperations.MISSING]: []
  }

  constructor(
    client: DynamoDBClient,
    maxAgePeriodMultiplier: number | null = null
  ) {
    super(HeartbeatOperations.ENTITY_TYPE, null, client)

    // NOTE: this needs to be greater:
    // - if time diff between GHA machines and AWS machines (in specific region) are large
    // - if getItems routine takes too long (Promise.allSettled under the hood). We want timestamp to get calculated separately!
    // - hence, default window is x3 for the heartbeat period
    // - accounting for ddb's eventual consistency, x2 is too tight
    this.maxAgePeriodMultiplier = maxAgePeriodMultiplier || 3
    this.maxAgeMs =
      HeartbeatOperations.PERIOD_SECONDS * this.maxAgePeriodMultiplier * 1000
  }

  // Check if a timestamp is fresh enough
  private getTimestampAge(timestamp: string): {
    ageMs: number
    isFresh: boolean
  } {
    const heartbeatTime = new Date(timestamp).getTime()
    const currentTime = new Date().getTime()
    const ageMs = currentTime - heartbeatTime

    return {
      ageMs,
      isFresh: ageMs <= this.maxAgeMs
    }
  }

  //
  //
  // METHODS ((INDEPENDENT)) OF INTERNAL STATE
  //
  //

  // 🔍 Check health of a single instance
  // .null = missing item
  // .unhealthy = heartbeat not fresh
  // .healthy = heartbeat within window
  async isInstanceHealthy(
    instanceId: string
  ): Promise<{ ageMs: number | null; state: keyof InstanceHealth }> {
    const item = await this.getItem(instanceId)
    if (!item) return { ageMs: null, state: 'missing' as const }

    const { ageMs, isFresh } = this.getTimestampAge(item.updatedAt)
    return {
      ageMs,
      state: isFresh
        ? HeartbeatOperations.HEALTHY
        : HeartbeatOperations.UNHEALTHY
    }
  }

  /**
   * Polls areAllInstancesHealthy until success or timeout.
   *
   * @param timeoutSeconds Total time to wait in seconds.
   * @param intervalSeconds Interval between polls in seconds.
   */
  async areAllInstancesHealthyPoll(
    instanceIds: string[],
    timeoutSeconds: number = HeartbeatOperations.PERIOD_SECONDS *
      this.maxAgePeriodMultiplier,
    intervalSeconds: number = HeartbeatOperations.PERIOD_SECONDS
  ): Promise<{ state: boolean; message: string }> {
    try {
      // register instances
      await this.registerInstancesForHealthCheck(instanceIds)

      // create waiter cb
      const checkFn = async (): Promise<WaiterResult> => {
        try {
          const done = await this.areAllInstancesHealthy()
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

      const result: WaiterResult = await waiter

      if (result.state === WaiterState.SUCCESS) {
        return {
          state: true,
          message: 'All instances are healthy 🎉'
        }
      } else if (result.state === WaiterState.TIMEOUT) {
        return {
          state: false,
          message: `Timed out after ${timeoutSeconds} seconds waiting for instances to be healthy ⌛️`
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

  // Check if all instances are healthy
  async areAllInstancesHealthy(): Promise<boolean> {
    await this.refreshInstanceHealth()
    const total = this._registeredInstanceIds.length
    const totalHealthy = this._instanceHealth.healthy.length
    const difference = total - totalHealthy

    core.info(`Heartbeat tracking: ${totalHealthy}/${total} are healthy`)

    // 🔍 These are for logging purposes
    if (difference === 0) {
      core.info('Heartbeat tracking: no unhealthy  - yay! 🍻')
    } else if (difference <= 0) {
      throw new Error(
        `Heartbeat tracking: There are more healthy instances (${totalHealthy}) than registered (${total}) - how?`
      )
    } else {
      core.info(
        `Heartbeat tracking: not all registered instances are healthy - try again ♻️`
      )
    }

    return difference === 0
  }

  //
  //
  // PRIVATE METHODS
  //
  //

  // Register instances to track
  private async registerInstancesForHealthCheck(instanceIds: string[]) {
    core.info(
      `Heartbeat tracking: registered ${instanceIds.length} instances: ${instanceIds}`
    )
    this._registeredInstanceIds = [...instanceIds]
    this._instanceHealth = {
      [HeartbeatOperations.HEALTHY]: [],
      [HeartbeatOperations.UNHEALTHY]: [],
      [HeartbeatOperations.MISSING]: []
    }
  }

  // Refresh health status
  private async refreshInstanceHealth(): Promise<void> {
    if (this._registeredInstanceIds.length === 0)
      throw new Error(
        'Heartbeat tracking: no instances registered for health checks'
      )

    core.info(
      `Heartbeat tracking: checking health of ${this._registeredInstanceIds.length} instances`
    )

    const newHealth: InstanceHealth = {
      [HeartbeatOperations.HEALTHY]: [],
      [HeartbeatOperations.UNHEALTHY]: [],
      [HeartbeatOperations.MISSING]: []
    }

    // 🔍 Mutates newHealth to classify instance id
    // 🔍 .all settled OK here. health check will fail on any missing new health
    await Promise.allSettled(
      this._registeredInstanceIds.map((id) =>
        this.classifyInstance(id, newHealth)
      )
    )

    // 🔍 Detailed logging
    core.info(
      `Heartbeat tracking: HEALTH STATUS\n` +
        `- healthy: ${newHealth.healthy.join(', ') || 'none'}\n` +
        `- unhealthy: ${newHealth.unhealthy.join(', ') || 'none'}\n` +
        `- missing: ${newHealth.missing.join(', ') || 'none'}`
    )
    this._instanceHealth = newHealth
  }

  // 🔍 This is mutating the incoming healthState
  private async classifyInstance(
    instanceId: string,
    healthState: InstanceHealth
  ) {
    const { ageMs, state } = await this.isInstanceHealthy(instanceId)

    // purely for logging
    if (state === HeartbeatOperations.MISSING) {
      core.info(`Heartbeat tracking: missing - ${instanceId}`)
    } else {
      if (!ageMs)
        throw new Error(
          `Heartbeat tracking: ageMs cannot be falsy (${ageMs}) while instance is not missing (${state})`
        )

      const ageSeconds = Math.floor(ageMs / 1000)
      if (state === HeartbeatOperations.HEALTHY) {
        core.info(
          `Heartbeat tracking: healthy - ${instanceId} (age: ${ageSeconds}s)`
        )
      } else if (state === HeartbeatOperations.UNHEALTHY) {
        const timeWindow = this.maxAgeMs
        core.info(
          `Heartbeat tracking: unhealthy - ${instanceId} (age: ${ageSeconds}s, max allowed: ${timeWindow}s)`
        )
      } else {
        throw new Error(
          `Heartbeat tracking: instance heartbeat state has reached an invalid state ${state}`
        )
      }
    }

    // mutating healthState
    healthState[state].push(instanceId)
  }
}
