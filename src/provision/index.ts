import * as core from '@actions/core'
import { ProvisionInputs } from '../inputs/types.js'
import { composeInputs } from './compose-inputs.js'
import { selection } from './selection/index.js'
import { creation } from './creation/index.js'
import { postProvision } from './post-provision/index.js'
import { createEC2Service } from '../services/ec2/index.js'
import { createDynamoDBService } from '../services/dynamodb/index.js'
import { createSQSService } from '../services/sqs/index.js'
import { SelectionOutput } from './types.js'

export async function provision(inputs: ProvisionInputs): Promise<void> {
  const startTime = Date.now()
  const { awsRegion, tableName, mode, githubRunId: runId } = inputs
  core.info(`Time: starting ${mode} mode`)
  core.debug(JSON.stringify(inputs))

  const ec2Service = createEC2Service(awsRegion)
  const ddbService = createDynamoDBService(awsRegion, tableName)
  const sqsService = createSQSService(awsRegion)

  // INPUT
  // composeProvisionInputs()
  // .fetch all metadata, override values given idiosyncrasy of provision (ie. max-runtime-min)
  // .return 'merged', used for reset of provision routine
  // validateProvisionInputs()
  // .given 'merged', validate presence of values. IE: resource pool URLs, etc.
  const composedInputs = await composeInputs(
    inputs,
    ddbService.getGeneralMetadataOperations()
  )

  core.debug(
    `Composed: ${JSON.stringify({ ...composedInputs, ghRegistrationToken: '' })}`
  )

  // composedInputs.usageClass

  // SELECTION
  // selection()
  // .given resource pool, and requirements, pickup valid instance ids
  // 📝 Will need dumping mechanism (??) - or atleast deference to creation??
  let selectionOutput: SelectionOutput
  if (process.env.DISABLE_SELECTION === 'true') {
    selectionOutput = {
      numInstancesSelected: 0,
      numInstancesRequired: inputs.instanceCount,
      instances: [],
      labels: []
    }
  } else {
    selectionOutput = await selection({
      instanceCount: composedInputs.instanceCount,
      resourceClass: composedInputs.resourceClass,
      usageClass: composedInputs.usageClass,
      // 🔍 for knowing which queue to ref & requeueing
      resourceClassConfig: composedInputs.resourceClassConfig,
      allowedInstanceTypes: composedInputs.allowedInstanceTypes,
      sqsOps: sqsService.getResourceClassConfigOperations(), // sqs for: termination q; resource pools qs
      ddbOps: {
        instanceOperations: ddbService.getInstanceOperations(),
        heartbeatOperations: ddbService.getHeartbeatOperations(),
        workerSignalOperations: ddbService.getWorkerSignalOperations()
      }, // ddb for: locking, etc.
      ec2Ops: {
        instanceOperations: ec2Service.getInstanceOperations()
      },
      runId
    })
  }

  // CREATION
  // creation()
  // .given what is left + constraints (cpu, mmem) + locations (subnet ids), create fleet
  // .also, validates registration
  // .{status: 'success' | 'failure'}
  const creationOutput = await creation({
    ...composedInputs,
    numInstancesRequired: selectionOutput.numInstancesRequired,
    ec2Ops: {
      fleetOperations: ec2Service.getFleetOperations(), // 🔍 fleet creation
      instanceOperations: ec2Service.getInstanceOperations() // 🔍 safety precaution, immediate termination on fleet failures
    },
    ddbOps: {
      workerSignalOperations: ddbService.getWorkerSignalOperations(),
      heartbeatOperations: ddbService.getHeartbeatOperations(),
      instanceOperations: ddbService.getInstanceOperations()
    },
    runId
  })

  // POST-PROVISION
  // .if successful in creating fleet, release()
  // .if failure in creating fleet, output()
  await postProvision({
    selectionOutput,
    creationOutput,
    runId,
    maxRuntimeMin: composedInputs.maxRuntimeMin,
    idleTimeSec: composedInputs.idleTimeSec,
    // 🔍 for knowing which queue to ref if any resources need releasing
    resourceClassConfig: composedInputs.resourceClassConfig,
    ec2Ops: ec2Service.getInstanceOperations(),
    ddbOps: {
      instanceOperations: ddbService.getInstanceOperations()
    },
    sqsOps: sqsService.getResourceClassConfigOperations()
  })

  const duration = (Date.now() - startTime) / 1000
  core.info(`Time: completed ${mode} mode in ${duration.toFixed(2)} seconds`)
}
