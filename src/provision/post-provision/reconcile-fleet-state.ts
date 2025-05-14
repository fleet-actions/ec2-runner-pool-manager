import * as core from '@actions/core'
import { SelectionOutput, CreationOuput, FleetStates } from '../types.js'

// 🔍 Final validations prior to releasing or composing; Strictly returns 'success' or 'failed'
export function reconcileFleetState(
  selectionOutput: SelectionOutput,
  creationOutput: CreationOuput
): FleetStates {
  // First of:
  // - see if creation was a 'success'
  // - any other creation output is considered a failure
  const creationStatus = creationOutput.state
  if (creationStatus !== 'success') {
    core.info(
      `Creation status is ${creationStatus}, and not a 'success'. Classifying as 'failed'...`
    )
    return 'failed'
  }

  const numSelected = selectionOutput.numInstancesSelected
  const numRequired = selectionOutput.numInstancesRequired
  const numCreated = creationOutput.numInstancesCreated
  if (numCreated + numSelected <= 0) {
    core.info("No instances are selected or created. Classifying as 'failed'")
    return 'failed'
  }

  // If creation is a 'success', perform other validation
  // - are the numInstancesCreated from creation the same as the number of numInstancesRequired by selection?
  // - .if so, 'success', otherwise 'failed'
  if (numRequired !== numCreated) {
    core.info(
      `Not all instances required instances were created - # of instances required (${numRequired}) are not the same as # of instances created (${numCreated}). Classifying as 'failed'`
    )
    return 'failed'
  }

  return 'success'
}
