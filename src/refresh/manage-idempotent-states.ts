import * as core from '@actions/core'
import {
  IdleTimeOperations,
  MaxRuntimeMinOperations
} from '../services/dynamodb/operations/metadata-operations.js'
import { SubnetOperations } from '../services/dynamodb/operations/metadata-operations.js'
import { ResourceClassConfigOperations as ddbRCOps } from '../services/dynamodb/operations/metadata-operations.js'
import { ResourceClassConfigOperations as sqsRCOps } from '../services/sqs/operations/resource-class-operations.js'
import { ResourceClassConfigInput, ValidMode } from '../inputs/types.js'

export async function manageIdleTime(
  idleTime: number,
  idleTimeOperations: IdleTimeOperations
): Promise<void> {
  // NOTE: for testing
  const foundIdleTime = await idleTimeOperations.getValue()
  if (foundIdleTime) {
    core.info(`found idle time: ${foundIdleTime}`)
  } else {
    core.info('no idle time found')
  }

  // simple write to ddb
  await idleTimeOperations.updateValue(idleTime)
  core.info('idle time successfully updated')
}

export async function manageSubnetIds(
  subnetIds: string[],
  subnetOps: SubnetOperations
): Promise<void> {
  // NOTE: for testing
  const foundSubnetIds = await subnetOps.getValue()
  if (foundSubnetIds) {
    core.info(`found subnet ids: ${foundSubnetIds}`)
  } else {
    core.info('no subnet ids found')
  }

  await subnetOps.updateValue(subnetIds)
  core.info('subnet ids successfully updated')
}

export async function manageMaxRuntimeMin(
  maxRuntimeMin: number,
  mrmOps: MaxRuntimeMinOperations
): Promise<void> {
  // NOTE: for testing
  const foundMrm = await mrmOps.getValue()
  if (foundMrm) {
    core.info(`found max runtime min: ${foundMrm}`)
  } else {
    core.info('no max runtime min found')
  }

  await mrmOps.updateValue(maxRuntimeMin)
  core.info('max runtime min successfully updated')
}

// Accepting rcc straight from input
export async function manageResourceClassConfiguration(
  mode: ValidMode,
  rcc: ResourceClassConfigInput,
  sqsRCOps: sqsRCOps,
  ddbRCOps: ddbRCOps
) {
  const exstingRC = await ddbRCOps.getValue()
  if (exstingRC) {
    core.info(`existing rc found - config: ${JSON.stringify(exstingRC)}`)
  } else {
    core.info('no resource class config found...')
  }

  // create queues based on incoming rcc anyway
  core.info(`creating resource pool queues (${Object.keys(rcc).join(', ')})...`)
  const newRCC = await sqsRCOps.populateWithQueueUrls(mode, rcc)
  core.info(
    `created resource pool queues (${Object.keys(newRCC).join(', ')})...`
  )

  // store incoming rc anyway
  ddbRCOps.updateValue(newRCC)
  core.info('stored resource pool queue details...')
}
