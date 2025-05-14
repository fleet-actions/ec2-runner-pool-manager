import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
// import { UNSPECIFIED_MAX_RUNTIME_MINUTES } from '../../src/inputs/defaults.js'
import { UNSPECIFIED_MAX_RUNTIME_MINUTES } from '../../__fixtures__/inputs/fixtures.js'
import { GeneralMetadataOperations } from '../../src/services/dynamodb/operations/metadata-operations.js'
import * as core from '../../__fixtures__/core' // Using the existing core mock

// Mock dependencies
jest.unstable_mockModule('@actions/core', () => core)

// Import the actual functions directly
const { composeInputs, mergeInputAndMetadata, validateMerged } = await import(
  '../../src/provision/compose-inputs'
)

describe('compose-inputs', () => {
  let ddbOps: MockProxy<GeneralMetadataOperations>

  beforeEach(() => {
    jest.clearAllMocks()
    ddbOps = mock<GeneralMetadataOperations>()
  })

  // --- Tests for mergeInputAndMetadata (using the real implementation) ---
  describe('mergeInputAndMetadata', () => {
    it('should merge objects, prioritizing properties from inputs', () => {
      const inputs = { a: 1, b: 2, maxRuntimeMin: 120 } as any
      const metadata = { a: 10, c: 3, maxRuntimeMin: 60 } as any

      const merged: any = mergeInputAndMetadata(inputs, metadata)

      expect(merged.a).toBe(inputs.a)
      expect(merged.b).toBe(inputs.b)
      expect(merged.c).toBe(metadata.c)
      expect(merged.maxRuntimeMin).toBe(inputs.maxRuntimeMin) // Input runtime takes precedence here
    })

    it('should use metadata maxRuntimeMin when input maxRuntimeMin is UNSPECIFIED', () => {
      const inputs = {
        maxRuntimeMin: UNSPECIFIED_MAX_RUNTIME_MINUTES,
        otherInput: 'value'
      } as any
      const metadata = { maxRuntimeMin: 60, otherMeta: 'value2' } as any

      const merged: any = mergeInputAndMetadata(inputs, metadata)

      expect(merged.maxRuntimeMin).toBe(metadata.maxRuntimeMin) // Idiosyncratic override
      expect(merged.otherInput).toBe(inputs.otherInput) // Other input value preserved
      expect(merged.otherMeta).toBe(metadata.otherMeta) // Other metadata value preserved
    })

    it('should use input maxRuntimeMin when it is specified (not UNSPECIFIED)', () => {
      const specifiedRuntime = 90
      const inputs = { maxRuntimeMin: specifiedRuntime } as any
      const metadata = { maxRuntimeMin: 60 } as any

      const merged = mergeInputAndMetadata(inputs, metadata)

      expect(merged.maxRuntimeMin).toBe(inputs.maxRuntimeMin) // Input runtime takes precedence
    })
  })

  // --- Tests for composeInputs (using the real mergeInputAndMetadata) ---
  describe('composeInputs', () => {
    // Use more representative (but still simplified) objects for these tests
    const dummyInputs = {
      inputProp: 'inputVal',
      maxRuntimeMin: 120,
      resourceClass: 'medium'
    } as any
    const dummyMetadata = {
      metaProp: 'metaVal',
      inputProp: 'metaOverridden', // Will be overridden by input
      maxRuntimeMin: 60,
      resourceClassConfig: { medium: {}, large: {} }
    } as any

    beforeEach(() => {
      ddbOps.getAll.mockResolvedValue(dummyMetadata)
    })

    it('should call ddbOps.getAll to fetch all metadata', async () => {
      await composeInputs(dummyInputs, ddbOps)
      expect(ddbOps.getAll).toHaveBeenCalledTimes(1)
    })

    it('should return the result of merging inputs and metadata using the real merge function', async () => {
      const result = await composeInputs(dummyInputs, ddbOps)

      // Assert based on the expected outcome of the *real* merge function
      expect(result).toMatchObject({
        inputProp: 'inputVal', // Input takes precedence
        metaProp: 'metaVal', // Metadata included
        maxRuntimeMin: 120 // Input runtime takes precedence (as it's specified)
      })
    })

    it('should correctly handle the maxRuntimeMin override via the real mergeInputAndMetadata', async () => {
      const inputsWithUnspecifiedRuntime = {
        ...dummyInputs,
        maxRuntimeMin: UNSPECIFIED_MAX_RUNTIME_MINUTES
      } as any
      const result = await composeInputs(inputsWithUnspecifiedRuntime, ddbOps)

      expect(result).toMatchObject({
        inputProp: 'inputVal', // Input takes precedence
        metaProp: 'metaVal', // Metadata included
        maxRuntimeMin: 60 // Metadata runtime takes precedence (due to UNSPECIFIED input)
      })
    })

    it('should throw an error (from validateMerge) if input rc is not included in config', async () => {
      const inputWithIncorrectResourceClass = {
        ...dummyInputs,
        resourceClass: 'does-not-exist'
      }

      await expect(() =>
        composeInputs(inputWithIncorrectResourceClass, ddbOps)
      ).rejects.toThrow()
    })

    it('should call core.info for logging at start, and at end', async () => {
      await composeInputs(dummyInputs, ddbOps)
      expect(core.info).toHaveBeenCalledWith('starting compose routine...')
      expect(core.info).toHaveBeenCalledWith('completed compose routine...')
    })
  })

  // --- Tests for validateMerged ---
  describe('validateMerged', () => {
    it('should not throw an error for a valid resource class', () => {
      const validResourceClass = 'medium'
      const input = {
        resourceClass: validResourceClass,
        resourceClassConfig: {
          medium: { cpu: 1, memory: 2 },
          large: { cpu: 2, memory: 4 }
        }
        // ... other properties don't matter for this test
      } as any // Using 'any' for simplicity in test setup

      // Expecting no error to be thrown
      expect(() => validateMerged(input)).not.toThrow()
    })

    it('should throw an error for an invalid resource class', () => {
      const invalidResourceClass = 'small'
      const resourceConfig = {
        medium: { cpu: 1, memory: 2 },
        large: { cpu: 2, memory: 4 }
      }
      const input = {
        resourceClass: invalidResourceClass,
        resourceClassConfig: resourceConfig
        // ... other properties
      } as any // Using 'any' for simplicity

      const expectedClasses = Object.keys(resourceConfig).join(', ')
      const expectedErrorMessage = `Specified resource class (${invalidResourceClass}) not included in config ${expectedClasses}`

      // Expecting an error with a specific message
      expect(() => validateMerged(input)).toThrow(expectedErrorMessage)
    })

    it('should throw an error if resourceClassConfig is empty', () => {
      const resourceClass = 'any-class'
      const input = {
        resourceClass: resourceClass,
        resourceClassConfig: {}
        // ... other properties
      } as any

      const expectedErrorMessage = `Specified resource class (${resourceClass}) not included in config ` // Empty config list

      expect(() => validateMerged(input)).toThrow(expectedErrorMessage)
    })
  })
})
