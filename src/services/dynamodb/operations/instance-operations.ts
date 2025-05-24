import * as core from '@actions/core'
// import { DynamoDBClient } from '../dynamo-db-client.js'
import {
  // GetCommand,
  PutCommand,
  UpdateCommand,
  // ScanCommand
  QueryCommand,
  DeleteCommand
  // QueryCommandOutput,
  // BatchWriteCommand
} from '@aws-sdk/lib-dynamodb'
import { BasicOperations } from './basic-operations.js'
import type { BasicItem } from './basic-operations.js'
import { DynamoDBClient } from '../dynamo-db-client.js'

export type InstanceStates =
  | 'idle'
  | 'claimed'
  | 'running'
  | 'terminated'
  | 'created'

// Basic item defined PK, SK, updatedAt, etc.
export interface InstanceItem extends BasicItem {
  // 🔍 Unlike basic item, identifier is certain to exist (non nullable) - so narrow typing
  identifier: string

  // 🔍 on registration, there is always an instance state
  state: InstanceStates
  // 🔍 Use single threshold (ISOZ), if ISOZ is older than current new Date(), then state is NOT valid
  threshold: string
  runId: string

  resourceClass: string
  instanceType: string
}

export interface InstanceTransitionInput {
  id: string
  // 🔍 '<empty>' erid, '...' nrid (occurs in selection)
  // 🔍 '...' erid, '<empty>' nrid (occurs in post-provision-release & release)
  expectedRunID: string
  newRunID: string
  expectedState: InstanceStates
  newState: InstanceStates
  newThreshold: string | null // ISOZ
  conditionSelectsUnexpired: boolean
  // isolationCheck: boolean // 🔍 No longer needed as exp/newRID will always be provided
}

// 🔍 Might not use basic value operations for this one.
// .OK on some code duplication for now.
export class InstanceOperations extends BasicOperations {
  static ENTITY_TYPE = 'INSTANCE'

  constructor(client: DynamoDBClient) {
    super(InstanceOperations.ENTITY_TYPE, null, client)
  }

  //
  //
  // USED PUBLIC INTERFACES (To be Tested)
  //
  //

  /**
   * Expires an instance by updating its threshold to 1min past current time.
   * Effect: system mechanisms with send termination signal to instance
   *
   * @param {object} params - The instance parameters
   * @param {string} params.id - Instance identifier
   * @param {string} params.runId - Run ID that must match current record
   * @param {InstanceStates | null} params.state - Current state of the instance (if null, will expire from any state)
   *
   * @returns {Promise<void>} Resolves when expiration completes successfully
   * @throws {Error} Throws error when state transition fails
   */
  async expireInstance({
    id,
    runId,
    state
  }: {
    id: string
    runId: string
    state: InstanceStates | null
  }) {
    const now = Date.now()
    const past = new Date(now + -5 * 60 * 1000).toISOString() // 100 min in past
    core.debug(
      `Expiring instance. See now(${new Date(now).toISOString()}) and passed past (${past})`
    )

    if (!state) {
      core.info(
        'Performing general instance expiration as incoming state is undefined'
      )
      state = ((await this.getGenericItem(id, true)) as InstanceItem).state
    }

    await this.instanceStateTransition({
      id,
      expectedRunID: runId,
      newRunID: runId,
      expectedState: state,
      newState: state,
      newThreshold: this.getISOZDate(past),
      conditionSelectsUnexpired: true
    })
  }

  // 🔍 REFRESH (managing terminations)
  async getExpiredInstancesByStates(
    states: InstanceStates[]
  ): Promise<Array<InstanceItem>> {
    const now = this.getISOZDate()

    // Create placeholders for each state value using reduce
    // ie: :state1 => 'running', :state2 => 'idle', ...
    const stateValues = states.reduce(
      (acc, state, idx) => {
        acc[`:state${idx}`] = state
        return acc
      },
      {} as Record<string, string>
    )

    // Filter - Do not include if
    // - not part of the input states
    // - record is fresh (threshold)
    // - record has no threshold, either empty '', or non-existent
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: `#state IN (${Object.keys(stateValues).toString()}) AND attribute_exists(#threshold) AND #threshold <> :emptyThreshold AND #threshold < :now`,
      ExpressionAttributeNames: {
        '#state': 'state',
        '#threshold': 'threshold'
      },
      ExpressionAttributeValues: {
        ':pk': this.getPK(),
        ...stateValues,
        ':now': now,
        ':emptyThreshold': ''
      }
    })

    try {
      const result = await this.client.getClient().send(command)

      if (!result.Items || result.Items.length === 0) {
        return []
      }

      return result.Items as InstanceItem[]
    } catch (err) {
      core.error(
        `Failed to get old instances with states ${states.join(', ')}: ${err}`
      )
      throw err
    }
  }

  // 🔍 PROVISION (DUMPING)
  async deleteInstanceItems(ids: string[], runId: string | null = null) {
    // all settled OK on hard deletion; ensures all signals sent
    return await Promise.allSettled(
      ids.map((id) => this.deleteInstanceItem(id, runId))
    )
  }

  // PROVISION (Regisration of created instances)
  // WEAK & STRONG REGISTRATION
  // WEAK: 'created', still unknown if instance has booted up OK. state of instance on initial creation, only comms initial runId and reasonable threshold
  async instanceCreatedRegistration({
    id,
    runId,
    threshold,
    resourceClass,
    instanceType
  }: {
    id: string
    runId: string
    threshold: string
    resourceClass: string
    instanceType: string
  }): Promise<boolean> {
    core.info(`Registering instance ${id} as 'created'`)

    // 🔍 pre-process threshold to hold standard internal isoz format
    threshold = this.getISOZDate(threshold)

    const bareInstanceStates: Omit<InstanceItem, keyof BasicItem> = {
      runId,
      threshold,
      resourceClass,
      instanceType,
      // 🔍 on instance created registration, immediately 'created' state
      // .will be changed on running registration
      state: 'created'
    }

    // the entrance state
    const result = await this.putInstanceItem(id, bareInstanceStates, true)
    return result
  }

  // STRONG: 'running', state of instance when confirmed set up.
  // 🔍 Registers instance to running from creation
  async instanceRunningRegistration({
    id,
    runId,
    threshold
  }: {
    id: string
    runId: string
    threshold: string
  }): Promise<boolean> {
    core.info(`Registering instance ${id} as 'running' (from 'created')`)

    // 🔍 pre-process threshold to hold standard internal isoz format
    threshold = this.getISOZDate(threshold)

    // perform transition from 'created' to 'running'
    await this.instanceStateTransition({
      id,
      expectedRunID: runId,
      newRunID: runId,
      expectedState: 'created',
      newState: 'running',
      newThreshold: threshold,
      conditionSelectsUnexpired: true
    })
    return true
  }

  // 🔍 RELEASE
  async getInstancesByRunId(runId: string): Promise<Array<InstanceItem>> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'runId = :runId',
      ExpressionAttributeValues: {
        ':pk': this.getPK(),
        ':runId': runId
      }
      // 🔍 No ProjectionExpression: '' to get all attributes
    })

    try {
      const result = await this.client.getClient().send(command)

      if (!result.Items || result.Items.length === 0) {
        return []
      }

      return result.Items as InstanceItem[]
    } catch (err) {
      core.error(`Failed to get instance IDs for runId ${runId}: ${err}`)
      throw err
    }
  }

  // 🔍 CORE INTERFACE FACILITATING TRANSITION
  // .Potentially used in all modes; throws errors on any failures
  /**
   * Transitions an instance from one state to another with run ID verification
   *
   * @param {object} params - The transition parameters
   * @param {string} params.id - Instance identifier
   * @param {string} params.expectedRunID - Run ID that must match current record
   * @param {string} params.newRunID - New run ID to assign to the instance
   * @param {InstanceStates} params.expectedState - Expected current state of instance
   * @param {InstanceStates} params.newState - New state to transition to
   * @param {string|null} params.newThreshold - New threshold value (ISO date string or if null, is current time in ISOZ)
   * @param {boolean} params.conditionSelectsUnexpired - When true, transition only succeeds if threshold > now (unexpired)
   *                                                   When false, transition only succeeds if threshold < now (expired)
   *
   * @throws {Error} Throws error when transition fails, including detailed conditional check failures
   * @returns {Promise<void>} Resolves when transition completes successfully
   */
  async instanceStateTransition({
    id,
    expectedRunID,
    newRunID,
    expectedState,
    newState,
    newThreshold,
    conditionSelectsUnexpired = true
  }: InstanceTransitionInput) {
    core.info(
      `Instance (${id}): state ${expectedState}->${newState}; runId ${expectedRunID || 'NONE'}->${newRunID || 'NONE'}; threshold ->${newThreshold}`
    )

    // 🔍 pre-process newThreshold to hold standard internal isoz format
    newThreshold = this.getISOZDate(newThreshold)

    const now = this.getISOZDate()
    const attributeNames = {
      '#state': 'state',
      '#threshold': 'threshold',
      '#runId': 'runId'
    }
    const attributeValues: Record<string, any> = {
      ':expectedState': expectedState,
      ':newState': newState,
      ':newThreshold': newThreshold,
      ':now': now,
      ':newRunID': newRunID,
      ':expectedRunID': expectedRunID
    }

    // Base condition expression
    const thresholdCondition = conditionSelectsUnexpired
      ? 'AND #threshold > :now' // condition passes if states are 'unexpired'
      : 'AND #threshold < :now' // condition passes if states are 'expired'
    const conditionExpr = `#state = :expectedState ${thresholdCondition} AND #runId = :expectedRunID`

    const command = new UpdateCommand({
      TableName: this.tableName,
      Key: {
        PK: this.getPK(),
        SK: this.getSK(id)
      },
      ConditionExpression: conditionExpr,
      UpdateExpression:
        'SET #state = :newState, #threshold = :newThreshold, #runId = :newRunID, updatedAt = :now',
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues,
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
    })

    try {
      await this.client.getClient().send(command)
    } catch (err: any) {
      core.warning(`State transition failed for instance ${id}`)
      if (err.name === 'ConditionalCheckFailedException') {
        // Inspect the failed item returned by DynamoDB

        const failedItem = (await this.getGenericItem(id, true)) || {}

        if (failedItem.state !== expectedState) {
          core.warning(
            `Conditional failure: state mismatch (expected=${expectedState}, actual=${failedItem.state}) 📝`
          )
        } else if (failedItem.threshold <= now) {
          core.warning(
            `Conditional failure: threshold (threshold=${failedItem.threshold}, now=${now}); The record found record is ${conditionSelectsUnexpired ? 'expired' : 'fresh'} ⌛️`
          )
        } else if (failedItem.runId !== expectedRunID) {
          core.warning(
            `Conditional failure: runId mismatch (expected=${expectedRunID}, actual=${failedItem.runId}) 🏃`
          )
        }
      }
      throw err
    }
  }

  //
  //
  // PUBLIC INTERFACE (EXPOSED FOR TESTING)
  //
  //

  // 🔍 Simple full put, condition with newness added
  async putInstanceItem(
    id: string,
    input: Omit<InstanceItem, keyof BasicItem>,
    itemMustBeNew: boolean = false
  ): Promise<boolean> {
    const item: BasicItem = {
      PK: this.getPK(),
      SK: this.getSK(id),
      entityType: InstanceOperations.ENTITY_TYPE,
      identifier: id,
      updatedAt: this.getISOZDate()
    }

    const instanceItem = { ...item, ...input } as InstanceItem

    const condExpression = itemMustBeNew
      ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      : undefined

    const command = new PutCommand({
      TableName: this.tableName,
      Item: instanceItem,
      ConditionExpression: condExpression,
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
    })

    try {
      await this.client.getClient().send(command)
      return true
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        core.warning(`Instance ${id} already exists; skipping registration`)

        const failedItem = (await this.getGenericItem(id, true)) || {}

        if (failedItem) {
          const fRunId = failedItem.runId
          core.warning(`See failed item: ${JSON.stringify(failedItem)}`)
          if (input.runId !== fRunId) {
            // 🔍 Likely a repeat instance id (less likely), or a race condition (likely)
            core.warning(
              `Run Id mismatch detected. Incoming ${input.runId}; Recorded ${fRunId}`
            )
          }
        } else {
          core.error(`Instance ${id} still not found`)
          throw err
        }

        return false
      }

      // 🔍 If it's not conditional failure, defer to throwing error
      throw err
    }
  }

  //
  //
  // PRIVATE INTERFACES (NOT USED EXT)
  //
  //

  // 🔍 Deletes a single instance record by id
  // 🔍 If run id is provided, then an isolation check is performed
  private async deleteInstanceItem(
    id: string,
    runId: string | null = null
  ): Promise<string> {
    core.info(`Deleting value ${id} of entity ${this.getPK()}`)

    const deleteParams: any = {
      TableName: this.tableName,
      Key: {
        PK: this.getPK(),
        SK: this.getSK(id)
      }
    }

    // Add condition expression if runId is provided
    if (runId) {
      deleteParams.ConditionExpression = 'runId = :runId'
      deleteParams.ExpressionAttributeValues = {
        ':runId': runId
      }
    }

    const command = new DeleteCommand(deleteParams)

    try {
      await this.client.getClient().send(command)
      return id // 🔍 so we know which id successfully deleted
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        const failedItem = (await this.getGenericItem(id, true)) || {}

        core.warning(
          `Isolation check failed for instance ${id}: runId mismatch. Recorded runid (${failedItem.runId}); Expected runid (${runId})`
        )
      }
      core.error(`Failed to delete instance ${id}: ${err}`)
      throw err
    }
  }
}
