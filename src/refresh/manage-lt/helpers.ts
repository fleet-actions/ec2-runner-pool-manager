import * as core from '@actions/core'
import { LTDatav2 } from '../../services/types.js'

export function hasLTChanged(newData: LTDatav2, storedData: LTDatav2) {
  const messages = []

  // Compare primitive properties
  // TODO: Handle changing LT names
  if (newData.name !== storedData.name)
    throw new Error(
      `new lt name found: (${storedData.name}). does not match stored name (${newData.name}), unable to handle changing LT names...`
    )

  if (newData.ami !== storedData.ami)
    messages.push(
      `new ami detected (${newData.ami}) (old: ${storedData.ami})...`
    )
  if (newData.iamInstanceProfile !== storedData.iamInstanceProfile)
    messages.push(
      `new instance profile detected (${newData.iamInstanceProfile}) (old: ${storedData.iamInstanceProfile})...`
    )

  if (newData.userDataHash !== storedData.userDataHash)
    messages.push(`modified user data script detected...`)

  const securityGroupsChanged = newData.securityGroupIds.some(
    (groupId) => !storedData.securityGroupIds.includes(groupId)
  )

  if (securityGroupsChanged)
    messages.push(
      `new sgs detected (${newData.securityGroupIds.join(' ')}) (old: ${storedData.securityGroupIds.join(' ')})`
    )

  // In case there's more/less sgs but is a subset/superset, still update
  if (newData.securityGroupIds.length !== storedData.securityGroupIds.length)
    messages.push(
      `new number of sgs detected ${newData.securityGroupIds.length} (old: ${storedData.securityGroupIds.length})`
    )

  const joinedMsgs = messages.join('\n')
  if (joinedMsgs.length > 0) {
    core.info(`Launch Template has changed: ${joinedMsgs}`)
    core.info(`Prompting change...`)
    return true
  } else {
    return false
  }
}

export function populateLTName(ltInput: LTDatav2, newName: string): LTDatav2 {
  const localName = ltInput.name ? ltInput.name : newName
  return { ...ltInput, name: localName }
}
