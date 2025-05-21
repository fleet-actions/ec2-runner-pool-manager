// test-script.ts
import * as fs from 'fs'
import { addBuiltInScript } from '../src/refresh/manage-lt/userdata-v2/main-script.js'
import { GitHubContext, LTDatav2 } from '../src/services/types.js'

// Minimal test data
const context: GitHubContext = {
  owner: 'test-owner',
  repo: 'test-repo'
}

const ltData: LTDatav2 = {
  userData: 'echo "Hello from test userData"'
} as any

// Generate the script
const result = addBuiltInScript('test-table', context, ltData)

// Delete the file if it exists
if (fs.existsSync('.output-script.sh')) {
  fs.unlinkSync('.output-script.sh')
}

// Write to file
fs.writeFileSync('.output-script.sh', result.userData as string)
console.log('Script written to .output-script.sh')
