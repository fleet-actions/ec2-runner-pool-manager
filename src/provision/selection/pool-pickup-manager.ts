/** Stateful pickup from the pool (simple)
 * Input (made internal state)
 * - resource class
 * - resource class config (will interface with sqs, so will need q-url)
 *
 * Default state
 * - Freq tolerance (say: 5) - how many times to tolerate seeing the same instance
 *
 * Kept Internal State
 * - Instance hash - { id, freq }
 *
 * Functionality
 * Single public interface, pickupFromPool
 * - sqsOps.initialize(rc, rcc)
 * - message = sqsOps.receiveAndDeleteResourceFromPool(rc, rcc)
 * - once received, what do we do?
 *   - if null, return null
 *   - if filtered (❌, no retry as will not )
 *   - ... just return? (keep this class small)
 *   - dont we have filters? then requeue? then cycle?
 */

import * as core from '@actions/core'
import {
  InstanceMessage,
  ResourceClassConfigOperations
} from '../../services/sqs/operations/resource-class-operations.js'
import { matchWildcardPatterns } from './utils/match-wildcard-patterns.js'
import type { ResourceClassConfig } from '../../services/types.js'

export class PoolPickUpManager {
  static readonly FREQ_TOLERANCE = 5
  private instanceFreq: Record<string, number> = {}

  constructor(
    // Selected resource class defined at initialization - cleaner
    private allowedInstanceTypes: string[],
    private resouceClass: string,
    private resourceClassConfig: ResourceClassConfig,
    private sqsOps: ResourceClassConfigOperations
  ) {}

  // rc already defined, empty input
  async pickup(): Promise<InstanceMessage | null> {
    let returnValue: InstanceMessage | null = null

    while (true) {
      // CASE: queue is empty
      const instanceMessage =
        await this.sqsOps.receiveAndDeleteResourceFromPool(
          this.resouceClass,
          this.resourceClassConfig
        )
      if (!instanceMessage) {
        returnValue = null
        break
      }

      // immediately register & validate frequency
      const freqStatus = this.registerAndValidateFrequency(instanceMessage.id)
      if (!freqStatus) {
        core.info(
          `We have cycled through the pool too many times, assuming empty; ${JSON.stringify(this.instanceFreq, null, 2)}`
        )
        return null
      }

      const { status, statusMessage } = this.classifyMessage(instanceMessage)

      if (status === 'delete') {
        core.warning(
          `${statusMessage}; now discarded from pool; picking up another from queue`
        )
      } else if (status === 'requeue') {
        core.warning(
          `${statusMessage}; placing back to pool; picking up another from pool`
        )
        await this.sqsOps.sendResourceToPool(
          instanceMessage,
          this.resourceClassConfig
        )
      } else if (status === 'ok') {
        core.info(`${statusMessage}; using as selected!`)
        returnValue = instanceMessage
        break
      } else {
        throw new Error(`Invalid status received ${status}`)
      }
    }

    return returnValue
  }

  // validates incoming message by certain filters:
  // - invalid rc (discard)
  // - !== cpu (discard)
  // - < mmem (discard)
  // - any pattern on allowedInstanceTypes (requeue)
  private classifyMessage(input: InstanceMessage): {
    status: 'ok' | 'delete' | 'requeue'
    statusMessage: string
  } {
    // all attributes used apart from id
    const { cpu, mmem, resourceClass, instanceType } = input

    // unlikely to proc, but if message has invalid rc from pool its been put in, then invalid
    const rc = this.resourceClassConfig[resourceClass]
    if (!rc) {
      return {
        status: 'delete',
        statusMessage: `The resource class of the picked up message is invalid. Picked up rc ${resourceClass}`
      }
    }

    // match specs, must be strict
    if (cpu !== rc.cpu || mmem < rc.mmem) {
      return {
        status: 'delete',
        statusMessage:
          cpu !== rc.cpu
            ? `Picked up cpu (${cpu}) is not equal to spec (${rc.cpu})`
            : `Picked up mmem (${mmem}) is too low for spec (${rc.mmem})`
      }
    }

    // NOTE: if fails by filter, this needs to proc a requeue
    const isNameValid = matchWildcardPatterns(
      this.allowedInstanceTypes,
      instanceType
    )
    if (!isNameValid) {
      return {
        status: 'requeue',
        statusMessage: `The picked up instance type ${instanceType} does not match allowed instance types (${this.allowedInstanceTypes})`
      }
    }

    return {
      status: 'ok',
      statusMessage: 'No issue'
    }
  }

  private registerAndValidateFrequency(id: string): boolean {
    let freq = this.instanceFreq[id]
    if (!freq) freq = 0

    if (freq >= PoolPickUpManager.FREQ_TOLERANCE) return false

    freq += 1
    this.instanceFreq[id] = freq
    return true
  }
}
