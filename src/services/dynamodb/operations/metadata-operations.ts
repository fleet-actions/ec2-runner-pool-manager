import * as core from '@actions/core'
import { ApplicationOperations } from './application-operations.js'
import { BasicValueOperations } from './basic-operations.js'
import { DynamoDBClient } from '../dynamo-db-client.js'
import {
  LTDatav2,
  Metadata,
  RegistrationTokenData,
  ResourceClassConfig
} from '../../types.js'

export class BasicMetadataOperations<T> extends BasicValueOperations<T> {
  static ENTITY_TYPE = 'METADATA'
  constructor(identifier: string, client: DynamoDBClient) {
    super(BasicMetadataOperations.ENTITY_TYPE, identifier, client)
  }
}

// STRUCTURE:
// .validateValue static class method (testable)
// .getProvisionValue instance method (less testable)
export class IdleTimeOperations extends BasicMetadataOperations<number> {
  static validateValue(input: number | null): number {
    if (input === null || isNaN(input))
      throw new Error('METADATA: idle time not defined')
    return input
  }

  constructor(client: DynamoDBClient) {
    super('idle_time_sec', client)
  }

  async getProvisionValue() {
    return IdleTimeOperations.validateValue(await this.getValue())
  }
}

export class SubnetOperations extends BasicMetadataOperations<string[]> {
  static validateValue(input: string[] | null) {
    if (!input) throw new Error('METADATA: subnet not defined')
    if (input.length === 0) throw new Error('Metadata: no subnet defined')
    return input
  }

  constructor(client: DynamoDBClient) {
    super('subnet_ids', client)
  }

  async getProvisionValue() {
    return SubnetOperations.validateValue(await this.getValue())
  }
}

export class RegistrationTokenOperations extends BasicMetadataOperations<RegistrationTokenData> {
  static validateValue(input: RegistrationTokenData | null) {
    if (!input || !input.token)
      throw new Error('METADATA: registration token not defined')

    const expiresAt = new Date(input.expires_at)
    const now = new Date()

    if (expiresAt < now) {
      const diffMs = now.getTime() - expiresAt.getTime()
      const diffMins = Math.round(diffMs / 60000) // Convert milliseconds to minutes
      throw new Error(
        `METADATA: Registration token expired ${diffMins} minutes ago.`
      )
    }

    return input
  }

  constructor(client: DynamoDBClient) {
    super('gh_registration_token', client)
  }

  async getProvisionValue() {
    return RegistrationTokenOperations.validateValue(await this.getValue())
  }
}

export class MaxRuntimeMinOperations extends BasicMetadataOperations<number> {
  static validateValue(input: number | null) {
    if (!input && input !== 0)
      throw new Error('METADATA: max runtime min not defined')
    if (input < 0)
      throw new Error('METADATA: recorded max runtime min less than 0')
    return input
  }

  constructor(client: DynamoDBClient) {
    super('max_runtime_min', client)
  }

  async getProvisionValue() {
    return MaxRuntimeMinOperations.validateValue(await this.getValue())
  }
}

export class ResourceClassConfigOperations extends BasicMetadataOperations<ResourceClassConfig> {
  static validateValue(input: ResourceClassConfig | null) {
    if (!input) throw new Error('METADATA: resource class config not defined')

    // determine that all rccs have queue urls
    const keysWithoutQueueUrl: string[] = []
    Object.entries(input).filter(([key, value]) => {
      if (!value.queueUrl) keysWithoutQueueUrl.push(key)
    })
    if (keysWithoutQueueUrl.length > 0)
      throw new Error(
        `METADATA: some resource class configs have no associated queues: ${keysWithoutQueueUrl.join(', ')}`
      )

    return input
  }

  constructor(client: DynamoDBClient) {
    super('resource_class_config', client)
  }

  async getProvisionValue() {
    return ResourceClassConfigOperations.validateValue(await this.getValue())
  }
}

export class LaunchTemplateOperations extends BasicMetadataOperations<LTDatav2> {
  static validateValue(input: LTDatav2 | null) {
    if (!input) throw new Error('METADATA: lt not defined')
    if (!input.name)
      throw new Error('METADATA: lt has not name, likely not yet defined')
    return input
  }

  constructor(client: DynamoDBClient) {
    super('launch_template', client)
  }

  async getProvisionValue() {
    return LaunchTemplateOperations.validateValue(await this.getValue())
  }

  async getLaunchTemplateData(): Promise<LTDatav2 | null> {
    return await this.getValue()
  }

  // TODO: Should these be here or in the index & tested separately?
  async updateLaunchTemplateData(data: LTDatav2): Promise<void> {
    data = LaunchTemplateOperations.cleanIncomingLaunchTemplateData(data)

    const { messages, success } =
      LaunchTemplateOperations.validateIncomingLaunchTemplateData(data)
    if (!success) throw new Error(messages.join('; '))

    await this.updateValue(data)
  }

  static validateIncomingLaunchTemplateData(data: LTDatav2) {
    const messages = []
    if (!data.userDataHash)
      messages.push('Hashed User Data hash is required to store in the db')

    if (data.userData) messages.push('User Data cannot be stored in the db')

    if (data.userDataBase64)
      messages.push('Base64 enc User Data cannot be stored in the db')

    // only succeed if no messages
    const success = messages.length === 0
    return { messages, success }
  }

  // available for use outside of this operation
  static cleanIncomingLaunchTemplateData(data: LTDatav2): LTDatav2 {
    if (data.userData) {
      core.info('User Data will not be written to db')
    }

    if (data.userDataBase64) {
      core.info('User Data (base64) will not be written to db')
    }

    return { ...data, userData: '', userDataBase64: '' }
  }
}

export class GeneralMetadataOperations extends ApplicationOperations {
  async getAll(): Promise<Metadata> {
    // parallelized
    const [
      idleTimeSec,
      subnetIds,
      ghRegistrationToken,
      maxRuntimeMin,
      resourceClassConfig,
      launchTemplate
    ] = await Promise.all([
      new IdleTimeOperations(this.client).getProvisionValue(),
      new SubnetOperations(this.client).getProvisionValue(),
      new RegistrationTokenOperations(this.client).getProvisionValue(),
      new MaxRuntimeMinOperations(this.client).getProvisionValue(),
      new ResourceClassConfigOperations(this.client).getProvisionValue(),
      new LaunchTemplateOperations(this.client).getProvisionValue()
    ])

    return {
      idleTimeSec,
      subnetIds,
      ghRegistrationToken,
      maxRuntimeMin,
      resourceClassConfig,
      launchTemplate
    }
  }
}
