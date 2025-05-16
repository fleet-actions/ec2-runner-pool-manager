import * as core from '@actions/core'
import { fleetCreation } from './fleet-creation.js'
import { fleetValidation } from './fleet-validation.js'
import { CreationInput, CreationOuput } from '../types.js'

export async function creation(input: CreationInput): Promise<CreationOuput> {
  core.info('starting creation routine...')
  core.debug(
    // pollutes info log
    `recieved: ${JSON.stringify({ ...input, ec2Ops: '', ddbOps: '', resourceClassConfig: '', ghRegistrationToken: '' })}`
  )

  if (input.numInstancesRequired === 0) {
    core.info('creation routine terminated, no instances needed to create...')
    return {
      state: 'success',
      numInstancesCreated: 0,
      instances: [],
      labels: []
    }
  }

  // CREATION & VALIDATION
  // fleet creation will undertake (multiple attempts) to create fleets
  // .on creation, if still "successful". We will undertake additional validation
  // .can we see "state=*-success/*-errored". Validation will return true or false
  const fleetResult = await fleetCreation({
    launchTemplate: input.launchTemplate,
    subnetIds: input.subnetIds,
    resourceSpec: input.resourceSpec,
    resourceClass: input.resourceClass,
    allowedInstanceTypes: input.allowedInstanceTypes,
    numInstancesRequired: input.numInstancesRequired,
    ec2Ops: input.ec2Ops.fleetOperations
  })

  // this is where we would determine
  // Do validation if fleet creation is 'state=success' (ie. capacity pool available)
  const fleetState = await fleetValidation({
    fleetResult,
    ddbOps: input.ddbOps
  })

  // 📝 Do not allow 'partial' fleet state at this point;
  // .In the future; allow for graceful handling of 'partial' fleet state
  if (fleetState === 'partial')
    throw new Error('Invalid Fleet State: partial not allowed...')

  // TERMINATION
  // 🔍 Gathers the final state of fleet creation and determines if its appropriate to send termination signals
  const instanceIds = fleetResult.instances.map((instance) => instance.id)
  if (fleetState !== 'success' && instanceIds.length > 0) {
    core.warning(`Termination signals will be sent to ${instanceIds}`)
    await input.ec2Ops.instanceOperations.terminateInstances(instanceIds)
  }

  core.info('completed creation routine...')
  return {
    state: fleetState,
    numInstancesCreated: fleetResult.instances.length,
    instances: fleetResult.instances,

    // 🔍 Given labels to hosts are the same as their instance ids! (see user data)
    labels: instanceIds
  }
}
