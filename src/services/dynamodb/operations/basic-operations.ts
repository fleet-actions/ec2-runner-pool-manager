import { ApplicationOperations } from './application-operations.js'
import { DynamoDBClient } from '../dynamo-db-client.js'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandOutput,
  DeleteCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb'

export interface BasicItem {
  PK: string
  SK: string
  entityType: string
  identifier: string | null
  updatedAt: string
}

export class BasicOperations extends ApplicationOperations {
  constructor(
    protected entityType: string,
    protected identifier: string | null,
    protected client: DynamoDBClient
  ) {
    super(client)
  }

  // 🔍 ISOZ format w/o fractional seconds; consistent with userdata
  protected getISOZDate(isoz: string | null = null) {
    const usedTime = isoz || new Date().toISOString() // e.g. "2025-04-24T18:31:04.111Z"
    let simple: string
    if (usedTime.split('.').length === 1) {
      // no extra fractional second
      simple = usedTime
    } else {
      simple = usedTime.split('.')[0] + 'Z' // "2025-04-24T18:31:04Z"
    }

    return simple
  }

  protected getPK(): string {
    return `TYPE#${this.entityType}`
  }

  protected getSK(input: string | null): string {
    const id = BasicOperations.determineId({
      stateId: this.identifier,
      newId: input
    })
    return `ID#${id}`
  }

  protected getIdentifier(input: string | null): string {
    return BasicOperations.determineId({
      stateId: this.identifier,
      newId: input
    })
  }

  async getGenericItem(
    newId: string | null = null,
    isConsistentRead: boolean = true // because why not
  ): Promise<Record<string, any> | null> {
    const command = new GetCommand({
      TableName: this.tableName,
      Key: {
        PK: this.getPK(),
        SK: this.getSK(newId)
      },
      ConsistentRead: isConsistentRead
    })

    const response = await this.client.getClient().send(command)
    return response.Item || null
  }

  async updateGenericItem(
    newId: string | null = null,
    attributes: Record<string, any> = {}
  ): Promise<void> {
    const baseItem = {
      PK: this.getPK(),
      SK: this.getSK(newId),
      entityType: this.entityType,
      identifier: this.getIdentifier(newId),
      updatedAt: this.getISOZDate()
    }

    // Merge base attributes with provided attributes
    const item = { ...baseItem, ...attributes }

    const command = new PutCommand({
      TableName: this.tableName,
      Item: item
    })

    await this.client.getClient().send(command)
  }

  //
  //
  // DELETE OPERATIONS
  //
  //

  // 🔍 Deletion by PK
  async clearPartition(): Promise<void> {
    // 1. Query all items for this partition key
    const pk = this.getPK()
    let ExclusiveStartKey: Record<string, any> | undefined = undefined
    const items: { PK: string; SK: string }[] = []

    do {
      const response: QueryCommandOutput = await this.client.getClient().send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'PK' },
          ExpressionAttributeValues: { ':pk': pk },
          ProjectionExpression: 'PK, SK',
          ExclusiveStartKey
        })
      )
      if (response.Items) {
        items.push(
          ...response.Items.map((item) => ({
            PK: item.PK as string,
            SK: item.SK as string
          }))
        )
      }
      ExclusiveStartKey = response.LastEvaluatedKey
    } while (ExclusiveStartKey)

    // 2. Batch delete in chunks of up to 25, executed in parallel
    const chunks: { PK: string; SK: string }[][] = []
    while (items.length > 0) {
      chunks.push(items.splice(0, 25))
    }
    const batchPromises = chunks.map((chunk) => {
      const deleteRequests = chunk.map(({ PK, SK }) => ({
        DeleteRequest: { Key: { PK, SK } }
      }))
      return this.client.getClient().send(
        new BatchWriteCommand({
          RequestItems: { [this.tableName]: deleteRequests }
        })
      )
    })

    // 🔍 all settled is fine as this is hard deletion
    await Promise.allSettled(batchPromises)
  }
  // You could also add a method to delete a specific item
  async deleteItem(newId: string | null = null): Promise<void> {
    const command = new DeleteCommand({
      TableName: this.tableName,
      Key: {
        PK: this.getPK(),
        SK: this.getSK(newId)
      }
    })

    await this.client.getClient().send(command)
  }

  //
  //
  // HELPER
  //
  //
  static determineId({
    stateId,
    newId
  }: {
    stateId: string | null
    newId: string | null
  }): string {
    const hasState = stateId != null
    const hasNew = newId != null

    if (hasState && hasNew) {
      throw new Error(
        `Cannot provide newId (${newId}) if stateId (${stateId}) already exists`
      )
    }
    if (!hasState && !hasNew) {
      throw new Error(
        `Cannot determine id: neither stateId nor newId was provided`
      )
    }

    // usage of `!` tells TS that newId or stateId cannot be both null
    return (stateId ?? newId)! // exactly one is non-null
  }
}

export const VALUE_COLUMN_NAME = 'value'
export interface BasicValueItem<T> extends BasicItem {
  [VALUE_COLUMN_NAME]: T
}

export class BasicValueOperations<T> extends BasicOperations {
  static VALUE_COLUMN_NAME = VALUE_COLUMN_NAME

  // convenience method for accessing value column name
  protected get valueColumnName() {
    return (this.constructor as typeof BasicValueOperations).VALUE_COLUMN_NAME
  }

  //
  //
  // READING ACTION
  //
  //
  async getItem(
    newId: string | null = null
  ): Promise<BasicValueItem<T> | null> {
    const item = await super.getGenericItem(newId)
    return item as BasicValueItem<T> | null
  }

  async getValue(newId: string | null = null): Promise<T | null> {
    const item: BasicValueItem<T> | null = await this.getItem(newId)
    return item?.[VALUE_COLUMN_NAME] || null
  }

  async getItems(newIds: string[]): Promise<(BasicValueItem<T> | null)[]> {
    // 🔍 all settled is OK to send signals to all items
    const results = await Promise.allSettled(
      newIds.map((id) => this.getItem(id))
    )

    return results.map((result) =>
      result.status === 'fulfilled' ? result.value : null
    )
  }

  async getValues(newIds: string[]): Promise<(T | null)[]> {
    // 🔍 all settled is OK to send signals to all items
    const results = await Promise.allSettled(
      newIds.map((id) => this.getValue(id))
    )

    return results.map((result) =>
      result.status === 'fulfilled' ? result.value : null
    )
  }

  //
  //
  // MUTATING ACTION
  //
  //
  async updateValue(value: T, newId: string | null = null): Promise<void> {
    await super.updateGenericItem(newId, { [VALUE_COLUMN_NAME]: value })
  }
}
