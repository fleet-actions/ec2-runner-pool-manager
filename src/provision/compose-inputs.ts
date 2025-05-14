import * as core from '@actions/core'
import { ProvisionInputs } from '../inputs/types.js'
import { GeneralMetadataOperations } from '../services/dynamodb/operations/metadata-operations.js'
import { Metadata } from '../services/types.js'
import { UNSPECIFIED_MAX_RUNTIME_MINUTES } from '../inputs/defaults.js'

// PURPOSE: Composition of inputs for Provision from user inputs + metadata
// INPUT: user input for mode provision
// STRUCTURE:
// .Fetch all stored metadata
// .Merge/Intersect user input and metadata
// .Enrich intersection
// .Validate intersection
// RETURN enriched & validated intersection

export async function composeInputs(
  inputs: ProvisionInputs,
  ddbOps: GeneralMetadataOperations
) {
  core.info('starting compose routine...')
  core.debug(`received: ${JSON.stringify(inputs)}`) // pollutes the log

  const metadata = await ddbOps.getAll()
  const merged = mergeInputAndMetadata(inputs, metadata)
  const enrichedMerged = enrichMerged(merged)

  // throws error if invalid
  validateMerged(enrichedMerged)

  core.info('completed compose routine...')
  return enrichedMerged
}

export function mergeInputAndMetadata(
  inputs: ProvisionInputs,
  metadata: Metadata
) {
  // NOTE: ordering, inputs takes precedence over metadata
  const merged = { ...metadata, ...inputs }

  // idiosycratic override (special metadata precendence)
  // .only maxRuntimeMin
  if (merged.maxRuntimeMin === UNSPECIFIED_MAX_RUNTIME_MINUTES) {
    merged.maxRuntimeMin = metadata.maxRuntimeMin
  }

  return merged
}

// NOTE: Input is an intersection
export function validateMerged(input: ProvisionInputs & Metadata) {
  // light validation
  // .incoming resource class needs to match a key in resource class config in metadata

  const resourceClass = input.resourceClass
  const resourceClasses = Object.keys(input.resourceClassConfig)

  if (!resourceClasses.includes(resourceClass)) {
    throw new Error(
      `Specified resource class (${resourceClass}) not included in config ${resourceClasses.join(', ')}`
    )
  }
}

// Enrich merged routine.
// .For now, it only populates resourceSpec for convenience of access later
export function enrichMerged(input: ProvisionInputs & Metadata) {
  // create a resource spec
  const resourceSpec = input.resourceClassConfig[input.resourceClass]

  return { ...input, resourceSpec }
}
