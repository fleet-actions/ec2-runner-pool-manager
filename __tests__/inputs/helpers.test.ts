import { jest } from '@jest/globals'
import * as core from '../../__fixtures__/core.js'
// import { getNumber, getStringArray, getString } from '../helpers'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { getNumber, getString, getStringArray, getGeneric, getDefaultForInput } =
  await import('../../src/inputs/helpers')

describe('input helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getDefaultForInput', () => {
    const sampleDefaults = {
      stringKey: 'testValue',
      numberKey: 42,
      boolKey: false,
      zeroKey: 0,
      nullKey: null // intentionally defined to check that it returns null (or the explicit null)
    }

    it('should return the value if the key exists in defaults (string)', () => {
      const result = getDefaultForInput('stringKey', sampleDefaults)
      expect(result).toBe('testValue')
    })

    it('should return the value if the key exists in defaults (number)', () => {
      const result = getDefaultForInput('numberKey', sampleDefaults)
      expect(result).toBe(42)
    })

    it('should return the value if the key exists in defaults (boolean false)', () => {
      const result = getDefaultForInput('boolKey', sampleDefaults)
      expect(result).toBe(false)
    })

    it('should return the value if the key exists in defaults (zero)', () => {
      const result = getDefaultForInput('zeroKey', sampleDefaults)
      expect(result).toBe(0)
    })

    it('should return null if the key does not exist in defaults', () => {
      const result = getDefaultForInput('nonexistentKey', sampleDefaults)
      expect(result).toBeNull()
    })

    it('should return the explicit null value if key exists and is set to null', () => {
      // This test shows that if the property is present and its value is null,
      // the function returns null (since that is the defined value).
      const result = getDefaultForInput('nullKey', sampleDefaults)
      expect(result).toBeNull()
    })
  })

  describe('getGeneric', () => {
    it('should return converted value when input is provided', () => {
      // Setup: input returns "hello", and our converter uppercases the string.
      core.getInput.mockReturnValue('hello')
      const converter = jest.fn((raw: string) => raw.toUpperCase())
      const result = getGeneric<string>('generic-input', converter)
      expect(result).toBe('HELLO')
      expect(converter).toHaveBeenCalledWith('hello')
    })

    it('should throw an error when input is empty and required is true', () => {
      // Setup: no input provided (empty string)
      core.getInput.mockReturnValue('')
      const converter = jest.fn((raw: string) => raw)
      expect(() => getGeneric<string>('generic-input', converter)).toThrow(
        'Input "generic-input" is required but no value was provided'
      )
    })

    it('should not convert the default value if used', () => {
      core.getInput.mockReturnValue('')
      const converter = jest.fn((raw: string) => raw.toUpperCase())
      // Here, since input is empty and not required, the function should return default value
      // and skip the converter.
      const result = getGeneric<string>('generic-input', converter, false, {
        'generic-input': 'hello'
      })
      expect(result).toBe('hello')
      expect(converter).not.toHaveBeenCalled()
    })

    it('should throw an error when optional input is empty and no default is provided', () => {
      core.getInput.mockReturnValue('')
      const converter = jest.fn((raw: string) => raw)
      expect(() =>
        getGeneric<string>('generic-input', converter, false, null)
      ).toThrow(
        'Input "generic-input" is optional but no default value was provided'
      )
    })

    it('should propagate errors thrown by the converter', () => {
      core.getInput.mockReturnValue('test')
      const converter = jest.fn(() => {
        throw new Error('Conversion failed')
      })
      expect(() => getGeneric<string>('generic-input', converter)).toThrow(
        'Conversion failed'
      )
    })

    it('should throw an error when required is false and default does not provide value', () => {
      core.getInput.mockReturnValue('')
      const converter = jest.fn((raw: string) => raw)
      expect(() =>
        getGeneric<string>('generic-input', converter, false, {
          'another-input': 123
        })
      ).toThrow(
        'Input "generic-input" is optional but no default value was provided'
      )
    })
  })

  describe('getNumber', () => {
    it('should return a valid number when provided', () => {
      core.getInput.mockReturnValue('42')
      expect(getNumber('test-input')).toBe(42)
      expect(core.getInput).toHaveBeenCalledWith('test-input', {
        required: true
      })
    })

    it('should return default value for optional input when not provided and a default is provided', () => {
      core.getInput.mockReturnValue('')
      expect(getNumber('test-input', false, { 'test-input': 10 })).toBe(10)
    })

    it('should throw error for invalid number', () => {
      core.getInput.mockReturnValue('not-a-number')
      expect(() => getNumber('test-input')).toThrow(
        'Input "test-input" with value "not-a-number" is not a valid number'
      )
    })

    it('should throw error when required input is missing', () => {
      core.getInput.mockImplementation(() => {
        throw new Error('Input required and not supplied: test-input')
      })
      expect(() => getNumber('test-input')).toThrow()
    })

    it('should throw error when optional input is missing and no default is provided', () => {
      // When required is false and defaultValue is null, an error should be thrown.
      core.getInput.mockReturnValue('')
      expect(() => getNumber('test-input', false, null)).toThrow(
        'Input "test-input" is optional but no default value was provided'
      )
    })
  })

  describe('getStringArray', () => {
    it('should split space-delimited string into array', () => {
      core.getInput.mockReturnValue('a b c')
      expect(getStringArray('test-input')).toEqual(['a', 'b', 'c'])
    })

    it('should handle multiple whitespace characters', () => {
      core.getInput.mockReturnValue('a  b\t\tc\n d')
      expect(getStringArray('test-input')).toEqual(['a', 'b', 'c', 'd'])
    })

    it('should return default value for optional input when not provided and default is provided', () => {
      core.getInput.mockReturnValue('')
      expect(
        getStringArray('test-input', false, {
          'test-input': ['default', 'another-default']
        })
      ).toEqual(['default', 'another-default'])
    })

    it('should filter out empty strings', () => {
      core.getInput.mockReturnValue('a  b    c')
      expect(getStringArray('test-input')).toEqual(['a', 'b', 'c'])
    })

    it('should throw error when required input is missing', () => {
      core.getInput.mockImplementation(() => {
        throw new Error('Input required and not supplied: test-input')
      })
      expect(() => getStringArray('test-input')).toThrow()
    })

    it('should throw error when optional input is missing and no default is provided', () => {
      core.getInput.mockReturnValue('')
      expect(() => getStringArray('test-input', false, null)).toThrow(
        'Input "test-input" is optional but no default value was provided'
      )
    })
  })

  describe('getString', () => {
    it('should return string value when provided', () => {
      core.getInput.mockReturnValue('test-value')
      expect(getString('test-input')).toBe('test-value')
    })

    it('should return default value for optional input when not provided and a default is provided', () => {
      core.getInput.mockReturnValue('')
      expect(getString('test-input', false, { 'test-input': 'default' })).toBe(
        'default'
      )
    })

    it('should throw error when required input is missing', () => {
      core.getInput.mockImplementation(() => {
        throw new Error('Input required and not supplied: test-input')
      })
      expect(() => getString('test-input')).toThrow()
    })

    it("should throw error when required input is simply empty (ie. '')", () => {
      core.getInput.mockReturnValue('')
      expect(() => getString('test-input')).toThrow(
        'Input "test-input" is required but no value was provided'
      )
    })

    it('should throw error when optional input is missing and no default is provided', () => {
      core.getInput.mockReturnValue('')
      expect(() => getString('test-input', false, null)).toThrow(
        'Input "test-input" is optional but no default value was provided'
      )
    })
  })
})
