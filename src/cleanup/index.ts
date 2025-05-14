import * as core from '@actions/core'
import { createEC2Service } from '../services/ec2/index.js'
import { createDynamoDBService } from '../services/dynamodb/index.js'
import { createSQSService } from '../services/sqs/index.js'

import type { ActionInputs } from '../inputs/types.js'

// 🔍 This mode is exclusively for internal usage to more easily test components by:
// - rapidly clearing compute and states

// 🔍 Ideally this mode will:
// - clear compute
// - clear ddb of (non-metadata) state
// - clear (ALL) queues of messages

// 💡 In the future cleanup may have varying modes to better control what is cleared
export async function cleanup(input: ActionInputs) {
  core.warning('Starting cleanup mode...')
  const { awsRegion, tableName } = input
  core.info(`Received: ${JSON.stringify({ awsRegion, tableName })}`)

  const ec2Service = createEC2Service(awsRegion)
  const ddbService = createDynamoDBService(awsRegion, tableName)
  const sqsService = createSQSService(awsRegion)

  // clear compute (regardless if they are registered or not)
  // - get all instance ids
  // - issue termination cmd
  core.info(`Getting all instances from account in ${awsRegion}...`)
  const instanceIds = await ec2Service
    .getInstanceOperations()
    .getAllInstanceIds()

  core.info(
    `Found the following instances (${instanceIds}); Calling termination...`
  )
  await ec2Service.getInstanceOperations().terminateInstances(instanceIds)
  core.info('Issued instance termination on the found instances...')

  // sleep for n mins
  const minutes = 0.5
  core.info(
    `Awaiting for ${minutes} minute for shutdown prior to cleaning ddb...`
  )
  await new Promise((r) => setTimeout(r, minutes * 60 * 1000))

  // 🔍 clear all non-metadata ddb state
  core.info('Clearing ddb of instance data...')
  core.info('Clearing ddb of bootstrap & hearbeat & instance information...')
  await Promise.all([
    await ddbService.getBootstrapOperations().clearPartition(),
    await ddbService.getHeartbeatOperations().clearPartition(),
    await ddbService.getInstanceOperations().clearPartition()
  ])

  core.info('DDB has been cleared...')

  // 💡 clear queues
  // - termination queue
  // - resource pools
  core.info('No resource clearing in queues yet...')
  const rcc = await ddbService
    .getResourceClassConfigOperations()
    .getProvisionValue()
  const sqsRCC = sqsService.getResourceClassConfigOperations()
  core.info('Resource class config has been initialized, performing rcc purge')
  await sqsRCC.purgeAllQueues(rcc)

  core.warning('Completed cleanup mode...')
}
