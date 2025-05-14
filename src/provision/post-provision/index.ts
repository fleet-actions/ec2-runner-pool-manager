import * as core from '@actions/core'
import { processFailedProvision } from './process-failed-provision.js'
import { processSuccessfulProvision } from './process-successful-provision.js'
import { reconcileFleetState } from './reconcile-fleet-state.js'
import { dumpResources } from './dump-resources.js'
import { PostProvisionInputs } from '../types.js'

export async function postProvision(input: PostProvisionInputs) {
  core.info('starting post provision routine...')
  // 🔍 Emptied ops objects to clean logged output
  core.info(
    `recieved: ${JSON.stringify({ ...input, ec2Ops: {}, sqsOps: {}, ddbOps: {}, resourceClassConfig: {} } as PostProvisionInputs)}`
  )
  const {
    selectionOutput,
    creationOutput,
    resourceClassConfig,
    maxRuntimeMin,
    idleTimeSec,
    runId,
    ec2Ops,
    ddbOps,
    sqsOps
  } = input

  try {
    const currentFleetState = reconcileFleetState(
      selectionOutput,
      creationOutput
    )
    if (currentFleetState === 'success') {
      await processSuccessfulProvision({
        selectionOutput,
        creationOutput,
        runId,
        maxRuntimeMin,
        ddbOps
      })
    } else {
      // 🔍 Will deliberately fail job here!
      // 🔍 Creation outputs are not used here as they have already been sent termination signals in aws.
      // - release resources -> setFailed
      await processFailedProvision({
        selectionOutput,
        idleTimeSec,
        resourceClassConfig,
        runId,
        ddbOps,
        sqsOps
      })
      core.setFailed(
        'Provision has gracefully failed: Resources have been released.\nSee provision messaging for cause of failures.'
      )
    }
    core.info('completed finalize provision routine...')
  } catch (error) {
    // NOTE: this is different from the graceful handling failed provision
    // core.warning(
    //   'Due to unhandled error in post-provision, now conducting a hard dump of selected and created resources...'
    // )
    // Resource dumping soft isolation

    await dumpResources({
      selectionOutput,
      creationOutput,
      runId,
      ec2Ops,
      ddbOps
    })
    core.error(
      `Post-provision error: ${error instanceof Error ? error.message : String(error)}`
    )
    if (error instanceof Error && error.stack) {
      core.error(error.stack)
    }
    throw error
  }
}
