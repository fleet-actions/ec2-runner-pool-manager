import * as core from '@actions/core'
import { releaseResources } from './release-resources.js'
import { createDynamoDBService } from '../services/dynamodb/index.js'
import { createSQSService } from '../services/sqs/index.js'
import type { ReleaseInputs } from '../inputs/types.js'

export async function release(inputs: ReleaseInputs): Promise<void> {
  const startTime = Date.now()
  const { awsRegion, tableName, githubRunId: runId, mode } = inputs
  core.info(
    `Time: starting ${mode} mode:` +
      JSON.stringify({ awsRegion, tableName, runId, mode })
  )

  const ddbService = createDynamoDBService(awsRegion, tableName)
  const sqsService = createSQSService(awsRegion)

  const resourceClassConfig = await ddbService
    .getResourceClassConfigOperations()
    .getProvisionValue()

  const idleTimeSec = await ddbService
    .getIdleTimeOperations()
    .getProvisionValue()

  await releaseResources({
    resourceClassConfig,
    runId,
    idleTimeSec,
    ddbOps: ddbService.getInstanceOperations(),
    sqsOps: sqsService.getResourceClassConfigOperations()
  })

  const duration = (Date.now() - startTime) / 1000
  core.info(`Time: completed ${mode} mode in ${duration.toFixed(2)} seconds`)
}
