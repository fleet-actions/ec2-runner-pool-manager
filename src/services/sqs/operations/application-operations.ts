import { SQSClient } from '../sqs-client.js'
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'

export interface CreateQueueOptions {
  visibilityTimeout: number // in seconds
}

export class ApplicationOperations {
  constructor(protected readonly sqsClient: SQSClient) {}

  /**
   * Creates a new standard queue
   * @param queueName The name of the queue
   * @param options Queue configuration options
   * @returns The URL of the created queue
   */
  async createQueue(queueName: string, options: CreateQueueOptions) {
    const command = new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        VisibilityTimeout: options.visibilityTimeout.toString()
      }
    })

    const response = await this.sqsClient.getClient().send(command)
    return response.QueueUrl || null
  }

  /**
   * Sends a message to a queue
   * @param queueUrl The URL of the queue
   * @param messageBody The message body
   * @returns The message ID
   */
  async sendMessage(queueUrl: string, messageBody: string) {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody
    })

    return await this.sqsClient.getClient().send(command)
  }

  /**
   * Receives messages from a queue immediately without waiting
   * @param queueUrl The URL of the queue
   * @param maxMessages Maximum number of messages to receive (1-10)
   * @returns Array of received messages
   */
  async receiveMessages(queueUrl: string, maxMessages: number = 1) {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 0, // Don't wait - return immediately if no messages
      AttributeNames: ['All']
    })

    const response = await this.sqsClient.getClient().send(command)
    return response.Messages || []
  }

  /**
   * Deletes a message from a queue
   * @param queueUrl The URL of the queue
   * @param receiptHandle The receipt handle of the message to delete
   */
  async deleteMessage(queueUrl: string, receiptHandle: string) {
    const command = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle
    })

    await this.sqsClient.getClient().send(command)
  }
}
