import * as core from '@actions/core'
import { PurgeQueueCommand } from '@aws-sdk/client-sqs'
import type { Message } from '@aws-sdk/client-sqs'
import {
  ApplicationOperations,
  CreateQueueOptions
} from './application-operations.js'
import { ResourceClassConfigInput, ValidMode } from '../../../inputs/types.js'
import type { ResourceClassConfig } from '../../types.js'

export interface InstanceMessage {
  id: string
  resourceClass: string // 🔍 redundant but OK
  instanceType: string
  cpu: number // 🔍 added as used in selection filter, obtainable in creation due to init attributes
  mmem: number // .mmem retaints original meaning as minimum, not exact
}

export interface SendResourcesToPoolsOutput {
  successful: Array<{ id: string; resourceClass: string }>
  failed: Array<{ id: string; resourceClass: string; error: string }>
}

export interface PopulateWithQueueUrlsInputs {
  mode: ValidMode
  githubRepoOwner: string
  githubRepoName: string
  rccInput: ResourceClassConfigInput
}

export class ResourceClassConfigOperations extends ApplicationOperations {
  static createQueueOptions: CreateQueueOptions = {
    visibilityTimeout: 30 // default 30 seconds, adjust as needed
  }

  // Intended for use in mode: refresh
  // This will initialize queue from inputs. Create -> Return queue urls.
  // Also store queue urls, cuz why not?
  // rccInput -> { rc1: {cpu, mmem}, rc2: {cpu, mmem}, ... }
  async populateWithQueueUrls(
    inputs: PopulateWithQueueUrlsInputs
  ): Promise<ResourceClassConfig> {
    const { mode, rccInput, githubRepoName, githubRepoOwner } = inputs
    if (mode !== 'refresh') {
      throw new Error(
        `cannot use this method from any other mode other than 'refresh'. see input mode ${mode}`
      )
    }

    const EMPTY_VALUE = ''
    const rcs = Object.entries(rccInput)

    // add this to context of wrapping fn
    const rccWithUrl = {} as ResourceClassConfig
    // for all resource classes, create a queue

    const rcPromises = rcs.map(async ([rcName, rcAttributes]) => {
      const awsQueueName = `${githubRepoOwner}-${githubRepoName}-${rcName}-ci-pool`
      const url = await this.createQueue(
        awsQueueName,
        ResourceClassConfigOperations.createQueueOptions
      )

      rccWithUrl[rcName] = { ...rcAttributes, queueUrl: url || EMPTY_VALUE }
    })

    // 🔍 usage of .all is a MUST. If we fail at creation of queue, we must know
    await Promise.all(rcPromises)

    // throw error on empty url creation
    const rccNamesWithEmptyUrls = Object.keys(rccWithUrl).filter((rcName) => {
      return rccWithUrl[rcName].queueUrl === EMPTY_VALUE
    })

    if (rccNamesWithEmptyUrls.length !== 0) {
      throw new Error(
        `Unable to create new queues for the following resource classes (${rccNamesWithEmptyUrls.join(', ')})`
      )
    }

    return rccWithUrl
  }

  async sendResourcesToPools(
    input: InstanceMessage[],
    resourceClassConfig: ResourceClassConfig
  ): Promise<SendResourcesToPoolsOutput> {
    const isValid = this.validateIncomingResourceClassesAgainstConfig(
      input.map((i) => i.resourceClass),
      resourceClassConfig
    )
    if (!isValid) throw new Error('Cannot send resources to resource pool')

    // `!` as validation confirms existence of rcc
    const rcc = resourceClassConfig
    const inputWithUrls = input.map((value) => {
      const url = rcc[value.resourceClass].queueUrl
      return { ...value, queueUrl: url } // pairing each instance message with a qurl
    })

    const sendPromises = inputWithUrls.map((o) => {
      const { queueUrl, ...msg } = { ...o }
      return this.serializedSend(queueUrl, msg)
    })

    // 🔍 all settled is OK. failed results are processed afterwards 👇
    const results = await Promise.allSettled(sendPromises)

    const processedResults = {
      successful: results
        .filter(
          (r): r is PromiseFulfilledResult<void> => r.status === 'fulfilled'
        )
        .map((r) => ({
          // 🔍 results is an array of objs. indexOf r, looks for the `r` obj
          // .on that array of objs to determine accompanying results
          id: inputWithUrls[results.indexOf(r)].id,
          resourceClass: inputWithUrls[results.indexOf(r)].resourceClass
        })),
      failed: results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => ({
          id: inputWithUrls[results.indexOf(r)].id,
          resourceClass: inputWithUrls[results.indexOf(r)].resourceClass,
          error: r.reason?.message || String(r.reason) || 'Unknown error'
        }))
    }

    return processedResults
  }

  // Method to purge all queues in the resource class configuration
  async purgeAllQueues(resourceClassConfig: ResourceClassConfig) {
    // Get all queue URLs
    const queueUrls = Object.values(resourceClassConfig).map(
      (rc) => rc.queueUrl
    )

    const response = await Promise.allSettled(
      queueUrls.map(async (queueUrl) => {
        const command = new PurgeQueueCommand({ QueueUrl: queueUrl })
        await this.sqsClient.getClient().send(command)
        return queueUrl
      })
    )

    const successful: string[] = []
    const unsucessful: string[] = []

    response.forEach((resp, ind) => {
      if (resp.status === 'fulfilled') {
        successful.push(queueUrls[ind])
      } else {
        unsucessful.push(queueUrls[ind])
      }
    })

    if (unsucessful.length && unsucessful.length !== queueUrls.length) {
      core.warning(
        `No all queues have been cleared. See unsuccessful queueURLs ${unsucessful}`
      )
    }

    return {
      successful,
      unsucessful
    }
  }

  /**
   * Sends a single instance message to its corresponding resource class queue.
   * @param instanceMessage The message containing instance details and resource class.
   * @throws Error if the resource class config is not initialized, the resource class is invalid,
   *         or the send operation fails.
   */
  async sendResourceToPool(
    instanceMessage: InstanceMessage,
    resourceClassConfig: ResourceClassConfig
  ): Promise<void> {
    // 1. Validate config and get Queue URL
    const { resourceClass } = instanceMessage
    const isValid = this.validateIncomingResourceClassesAgainstConfig(
      [resourceClass],
      resourceClassConfig
    )

    if (!isValid) throw new Error('Cannot receive resource from pool')
    const rcConfig = resourceClassConfig[resourceClass]

    // 2. Validate if the resource class exists in the config
    if (!rcConfig || !rcConfig.queueUrl) {
      core.error(
        `Attempted to send message for unregistered resource class: ${resourceClass}. Input: ${JSON.stringify(instanceMessage)}`
      )
      throw new Error(
        `Resource class "${resourceClass}" is not registered or has no associated queue URL.`
      )
    }

    const queueUrl = rcConfig.queueUrl

    // 3. Use the existing serializedSend method
    try {
      // Note: serializedSend doesn't need the queueUrl in the message object itself.
      // It expects the URL as the first argument and the message payload as the second.
      // The current instanceMessage structure is already suitable as the payload.
      await this.serializedSend(queueUrl, instanceMessage)
      core.info(
        `Successfully sent message for instance ${instanceMessage.id} to resource class ${resourceClass}`
      )
    } catch (error) {
      core.error(
        `Failed to send message for instance ${instanceMessage.id} to resource class ${resourceClass}. Error: ${error instanceof Error ? error.message : String(error)}`
      )
      // Re-throw the error to signal failure
      throw error
    }
  }

  /**
   * Receives a single message from a specific resource class queue,
   * processes and deletes it using a helper method, and returns the parsed message.
   * @param resourceClass The name of the resource class queue to poll.
   * @returns Parsed InstanceMessage or null if no message was available or processing failed gracefully.
   * @throws Error if configuration is invalid or an unrecoverable error occurs during processing.
   */
  async receiveAndDeleteResourceFromPool(
    resourceClass: string,
    resourceClassConfig: ResourceClassConfig
  ): Promise<InstanceMessage | null> {
    // 1. Validate config and get Queue URL
    const isValid = this.validateIncomingResourceClassesAgainstConfig(
      [resourceClass],
      resourceClassConfig
    )

    if (!isValid) throw new Error('Cannot receive resource from pool')
    const { queueUrl } = resourceClassConfig[resourceClass]

    try {
      // 2. Receive message(s)
      const messages = await this.receiveMessages(queueUrl, 1) // Using base class method

      if (!messages || messages.length === 0) {
        core.info(`No messages received from queue for ${resourceClass}.`)
        return null // No messages available
      }

      const message = messages[0]

      // 3. Delegate processing, deletion, and parsing to helper
      return await this.processAndDeleteMessage(
        queueUrl,
        resourceClass,
        message
      )
    } catch (error) {
      // Catch errors specifically from receiveMessages or the helper
      core.error(
        `Error in receiveAndDeleteResourceFromPool for ${resourceClass}: ${error instanceof Error ? error.message : String(error)}`
      )
      // Rethrow to signal failure in the overall operation
      throw error
    }
  }

  validateIncomingResourceClassesAgainstConfig(
    resourceClasses: string[],
    resourceClassConfig: ResourceClassConfig
  ): boolean {
    // 1/2. Get unique incoming resource class names
    const incomingClasses = Array.from(new Set(resourceClasses))

    // 3. Check each incoming class against the configuration
    const invalidClasses: string[] = []
    const classesWithMissingUrls: string[] = []

    for (const rcName of incomingClasses) {
      const rcConfig = resourceClassConfig[rcName]
      if (!rcConfig) {
        // Class not registered at all
        invalidClasses.push(rcName)
      } else if (!rcConfig.queueUrl || rcConfig.queueUrl.trim() === '') {
        // Class is registered, but queueUrl is missing or empty
        classesWithMissingUrls.push(rcName)
      }
      // If rcConfig exists and has a non-empty queueUrl, it's valid.
    }

    // 4. Report issues and return status
    let isValid = true
    if (invalidClasses.length > 0) {
      const registeredClasses = Object.keys(resourceClassConfig).sort()
      core.warning(
        `Validation failed: The following incoming resource classes are not registered: [${invalidClasses.join(', ')}]. Registered classes are: [${registeredClasses.join(', ')}].`
      )
      isValid = false
    }
    if (classesWithMissingUrls.length > 0) {
      core.warning(
        `Validation failed: The following registered resource classes are missing a valid Queue URL: [${classesWithMissingUrls.join(', ')}].`
      )
      isValid = false
    }

    return isValid
  }

  //
  //
  // PRIVATE INTERFACES
  //
  //

  private async serializedSend(queueUrl: string, input: InstanceMessage) {
    const str = JSON.stringify(input)
    await this.sendMessage(queueUrl, str)
  }

  /**
   * Helper method to process a single received SQS message.
   * It validates, deletes, and parses the message.
   * @param queueUrl The URL of the queue the message came from.
   * @param resourceClass The name of the resource class (for logging).
   * @param message The SQS Message object.
   * @returns Parsed InstanceMessage or null if validation/parsing fails gracefully.
   * @throws Error if deletion fails or parsing results in an error intended to halt execution.
   * @private
   */
  private async processAndDeleteMessage(
    queueUrl: string,
    resourceClass: string, // Added for context in logging/errors
    message: Message
  ): Promise<InstanceMessage | null> {
    const messageId = message.MessageId || 'UNKNOWN_ID' // For logging
    const receiptHandle = message.ReceiptHandle
    const body = message.Body

    // 1. Validate ReceiptHandle
    if (!receiptHandle) {
      core.warning(
        `Message (ID: ${messageId}) received from ${resourceClass} but missing ReceiptHandle. Cannot delete reliably. Skipping processing.`
      )
      // Cannot delete, so we shouldn't process. Return null.
      return null
    }

    try {
      // 2. Validate Body (do this before deleting)
      if (!body) {
        core.warning(
          `Message (ID: ${messageId}) received from ${resourceClass} but missing Body. Deleting empty/invalid message.`
        )
        await this.deleteMessage(queueUrl, receiptHandle) // Delete the invalid message
        core.info(
          `Deleted empty/invalid message ${messageId} from queue ${resourceClass}`
        )
        return null // Return null as there's no content
      }

      // 3. Delete the message (attempt this before parsing)
      // If deletion fails, we likely don't want to process as it might be processed again.
      await this.deleteMessage(queueUrl, receiptHandle)
      core.info(`Deleted message ${messageId} from queue ${resourceClass}`)

      // 4. Parse the message body
      try {
        const parsedMessage = JSON.parse(body) as InstanceMessage
        // Optional: Add further validation of the parsed object structure if needed
        return parsedMessage
      } catch (parseError) {
        core.error(
          `Failed to parse message body (ID: ${messageId}) from ${resourceClass} after deletion. Body: ${body}. Error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        )
        // Throw an error because the message is deleted but couldn't be processed.
        throw new Error(
          `Failed to parse deleted message ${messageId} from ${resourceClass}.`
        )
      }
    } catch (error) {
      // Catch errors from deleteMessage or re-thrown errors from parsing
      core.error(
        `Failed to process/delete message ${messageId} from ${resourceClass}. Error: ${error instanceof Error ? error.message : String(error)}`
      )
      // Rethrow to indicate failure in processing this specific message
      throw error
    }
  }
}
