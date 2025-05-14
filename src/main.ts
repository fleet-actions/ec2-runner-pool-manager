import * as core from '@actions/core'
import { inputs } from './inputs/index.js'
import { provision } from './provision/index.js'
import { refresh } from './refresh/index.js'
import { release } from './release/index.js'
import { cleanup } from './cleanup/index.js'

import {
  ActionInputs,
  ProvisionInputs,
  RefreshInputs,
  ReleaseInputs
} from './inputs/types.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const input = inputs()

    // NOTE: informs ts that input.mode can be any value
    switch (input.mode as string) {
      case 'provision':
        await provision(input as ProvisionInputs)
        break
      case 'release':
        await release(input as ReleaseInputs)
        break
      case 'refresh':
        await refresh(input as RefreshInputs)
        break
      case 'cleanup':
        await cleanup(input as ActionInputs)
        break
      case 'echo': // NOTE: This is for testing only
        await echo()
        break
      default:
        throw new Error(`Invalid mode: ${input.mode}`)
    }
  } catch (error) {
    // NOTE: eats any errors from inputs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function echo() {
  const message: string = core.getInput('echo')
  core.info(`The echo message is: ${message}`)
  core.setOutput('echo', message)
}
