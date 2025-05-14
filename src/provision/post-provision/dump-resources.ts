// 🔍 This routine is for hard dumping the provision's resources.
// .To handle ungraceful errors encountered in post-provisioning routine
// .This is to not let any compute resources go un-utilized
// .Ideally, this is not used, but this is more of a safety mechanism
// .This changes state on ddb, and directly sends termination instances
// .Effect on downstream jobs is if we have instances which are sent back to the pool and picked up by another job, this will cause them to get terminated. Which could be OK
// ..As such, effect on downstream jobs acceptable 👌
// Focus here is simplicity

import * as core from '@actions/core'
import { InstanceOperations as DDBInstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'
import { InstanceOperations as EC2InstanceOperations } from '../../services/ec2/operations/instance-operations.js'
import { CreationOuput, SelectionOutput } from '../types.js'

export interface DumpResourcesInput {
  selectionOutput: SelectionOutput
  creationOutput: CreationOuput
  runId: string
  ec2Ops: EC2InstanceOperations
  ddbOps: DDBInstanceOperations
}

export async function dumpResources(input: DumpResourcesInput) {
  const { selectionOutput, creationOutput, runId, ec2Ops, ddbOps } = input
  core.info(`🧹 Starting resource dump routine for run ID: ${runId}`)
  core.info(
    `Selected instances: ${selectionOutput.instances.length}, Created instances: ${creationOutput.instances.length}`
  )

  // 🔍 Selection:
  // - Hard Cleanup from record (regardless of state, but with isolation checks)
  // - Send signal to terminate instances
  core.info(
    `Processing selected resources with isolation checks (runId: ${runId})`
  )
  const ps = dumpSelectedResources(selectionOutput, runId, ddbOps, ec2Ops)

  // 🔍 Creation:
  // - Cleanup any accidentally registered resources (DDB OK w deletion of non-existent items)
  // - Send signal to terminate instances
  core.info('Processing created resources (no isolation checks required)')
  const pc = dumpCreatedResources(creationOutput, ddbOps, ec2Ops)

  await Promise.allSettled([ps, pc])
  core.info('🏁 Resource dump routine completed...')
}

// 🔍 Selected: Dumping of resources requires isolation checks!
export async function dumpSelectedResources(
  selectionOuput: SelectionOutput,
  runId: string,
  ddbOps: DDBInstanceOperations,
  ec2Ops: EC2InstanceOperations
) {
  const instanceIds = selectionOuput.instances.map((instance) => instance.id)

  if (instanceIds.length === 0) {
    core.info('There are no selected instances to dump')
    return
  }

  core.info(
    `🔄 Dumping ${instanceIds.length} selected instance(s) with runId isolation: ${instanceIds.join(', ')}`
  )
  const response = await ddbOps.deleteInstanceItems(instanceIds, runId)
  // 🔍 only the successful isolated deletions will be met straight termination

  const ids = response
    .filter((resp) => resp.status === 'fulfilled')
    .map((resp) => resp.value)

  core.info(
    `✅ Successfully verified and deleted ${ids.length}/${instanceIds.length} selected instances`
  )

  if (ids.length > 0) {
    core.info(`🧨 Terminating selected EC2 instances: ${ids.join(', ')}`)
    await ec2Ops.terminateInstances(ids)
    core.info(`✅ EC2 termination commands sent for selected instances`)
  } else {
    core.info(
      `⚠️ No selected instances passed isolation check - nothing to terminate`
    )
  }
}

// 🔍 Created: Dumping of resources requires no isolation checks
export async function dumpCreatedResources(
  creationOutput: CreationOuput,
  ddbOps: DDBInstanceOperations,
  ec2Ops: EC2InstanceOperations
) {
  const instanceIds = creationOutput.instances.map((instance) => instance.id)

  if (instanceIds.length === 0) {
    core.info('There are no created instances to dump')
    return
  }

  core.info(
    `🔄 Dumping ${instanceIds.length} created instance(s): ${instanceIds.join(', ')}`
  )
  const pDeletion = ddbOps.deleteInstanceItems(instanceIds)

  core.info(`🧨 Terminating created EC2 instances: ${instanceIds.join(', ')}`)
  const pEC2Termination = ec2Ops.terminateInstances(instanceIds)

  await Promise.allSettled([pDeletion, pEC2Termination])
  core.info(`✅ Created resources cleanup completed`)
}
