/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, you can create fixtures that export mock
 * functions and objects. For example, the core module is mocked in this test,
 * so that the actual '@actions/core' module is not imported.
 */
import { jest } from '@jest/globals'
import { ActionInputs } from '../src/inputs/types.js'
import * as core from '../__fixtures__/core.js'
import { inputs } from '../__fixtures__/inputs/fixtures.js'
import { provision } from '../__fixtures__/provision/index.js'
import { release } from '../__fixtures__/release/index.js'
import { refresh } from '../__fixtures__/refresh/fixture.js'

// Mocks should be declared before ((the module being tested is imported)).
Object.entries({
  '@actions/core': core,
  '../src/inputs/index.js': { inputs },
  '../src/provision/index.js': { provision },
  '../src/release/index.js': { release },
  '../src/refresh/index.js': { refresh }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { run } = await import('../src/main.js')

describe('main.ts', () => {
  const mockInputs = {
    provision: {
      mode: 'provision' as const
    } as ActionInputs,
    refresh: {
      mode: 'refresh' as const
    } as ActionInputs,
    release: {
      mode: 'release' as const
    } as ActionInputs
  }

  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('Calls the provision entry point', async () => {
    inputs.mockReturnValue(mockInputs.provision)
    await run()
    expect(provision).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('Calls the refresh entry point', async () => {
    inputs.mockReturnValue(mockInputs.refresh)
    await run()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('Calls the release entry point', async () => {
    inputs.mockReturnValue(mockInputs.release)
    await run()
    expect(release).toHaveBeenCalledTimes(1)
    expect(provision).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('Sets an failed status on an invalid mode', async () => {
    const randomMode = 'hello-123'
    inputs.mockReturnValue({ mode: randomMode } as any)
    await run()
    expect(core.setFailed).toHaveBeenNthCalledWith(
      1,
      `Invalid mode: ${randomMode}`
    )
  })
})
