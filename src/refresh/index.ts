import * as core from '@actions/core'
import { createDynamoDBService } from '../services/dynamodb/index.js'
import { createEC2Service } from '../services/ec2/index.js'
import { createGitHubService } from '../services/github/index.js'
import { createSQSService } from '../services/sqs/index.js'

import { manageRegistrationToken } from './manage-rt/index.js'
import { manageLT } from './manage-lt/index.js'
import {
  manageIdleTime,
  manageSubnetIds,
  manageMaxRuntimeMin,
  manageResourceClassConfiguration
} from './manage-idempotent-states.js'
import { manageTerminations } from './manage-terminations.js'
import { manageTable } from './manage-table/index.js'

import { RefreshInputs } from '../inputs/types.js'

export async function refresh(inputs: RefreshInputs): Promise<void> {
  const startTime = Date.now()
  core.info(
    `Time: starting ${inputs.mode} mode:` +
      JSON.stringify({
        ...inputs,
        githubToken: '',
        preRunnerScript: '',
        resourceClassConfig: ''
      }) // remove ghtoken and pollution
  )

  const {
    mode,
    awsRegion,
    tableName,
    idleTimeSec,
    maxRuntimeMin,
    subnetIds,
    resourceClassConfig,
    githubToken,
    githubRegTokenRefreshMins,
    githubRepoOwner,
    githubRepoName,
    ami,
    iamInstanceProfile,
    securityGroupIds,
    preRunnerScript
  } = inputs

  const ec2Service = createEC2Service(awsRegion)
  const ddbService = createDynamoDBService(awsRegion, tableName)
  const sqsService = createSQSService(awsRegion)
  const ghService = createGitHubService(githubToken, {
    owner: githubRepoOwner,
    repo: githubRepoName
  })

  await manageTable(ddbService.getApplicationOperations())

  await manageIdleTime(idleTimeSec, ddbService.getIdleTimeOperations())
  await manageSubnetIds(subnetIds, ddbService.getSubnetOperations())
  await manageMaxRuntimeMin(
    maxRuntimeMin,
    ddbService.getMaxRuntimeMinOperations()
  )

  await manageRegistrationToken(
    githubRegTokenRefreshMins,
    ghService.getRegistrationTokenOperations(),
    ddbService.getRegistrationTokenOperations()
  )

  await manageLT(
    tableName,
    { owner: githubRepoOwner, repo: githubRepoName },
    {
      ami,
      iamInstanceProfile,
      securityGroupIds,
      userData: preRunnerScript
    },
    ec2Service.getLaunchTemplateOperations(),
    ddbService.getLaunchTemplateOperations()
  )

  await manageResourceClassConfiguration({
    mode,
    rcc: resourceClassConfig,
    githubRepoName,
    githubRepoOwner,
    sqsRCOps: sqsService.getResourceClassConfigOperations(),
    ddbRCOps: ddbService.getResourceClassConfigOperations()
  })

  await manageTerminations({
    ec2Ops: ec2Service.getInstanceOperations(),
    ddbOps: {
      instanceOperations: ddbService.getInstanceOperations(),
      heartbeatOperations: ddbService.getHeartbeatOperations(),
      bootstrapOperations: ddbService.getBootstrapOperations()
    }
  })

  const duration = (Date.now() - startTime) / 1000
  core.info(
    `Time: completed ${inputs.mode} mode in ${duration.toFixed(2)} seconds`
  )
}
