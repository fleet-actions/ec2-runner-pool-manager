import * as dyn from 'jest-dynalite'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

// Create __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// console.log({ dyn }) // Now use __dirname with jest-dynalite

dyn.default.setup(__dirname) // 🔍
