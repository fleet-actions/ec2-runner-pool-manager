import * as core from '@actions/core'

/**
 * Utility that returns the default value for a given input name,
 * from the defaults object. If the defaults object does not have a value
 * for that name, then null is returned.
 */
export function getDefaultForInput<T>(
  name: string,
  defaults: Record<string, T>
): T | null {
  const pExists = Object.prototype.hasOwnProperty.call(defaults, name)
  if (pExists) {
    return defaults[name]
  } else {
    return null
  }
}

/**
 * Generic helper to retrieve an input, convert it to type T,
 * and enforce that if the input is optional, a default must be provided.
 *
 * @param name - Name of the input.
 * @param converter - A function that converts the raw input string to type T.
 * @param required - Whether the input is required. Defaults to true.
 * @param defaults - An object containing defaults keyed by the input name.
 * @returns The input converted to type T.
 */
export function getGeneric<T>(
  name: string,
  converter: (raw: string) => T,
  required = true,
  defaults: Record<string, any> | null = null
): T {
  // Look up the actual default value based on the input name (if defaults are provided)
  const actualDefault: T | null = defaults
    ? getDefaultForInput(name, defaults)
    : null

  // Retrieve the raw input via core.getInput.
  const rawValue = core.getInput(name, { required })

  // If nothing was provided...
  if (!rawValue || rawValue === '') {
    if (required) {
      throw new Error(`Input "${name}" is required but no value was provided`)
    }
    if (!required && actualDefault === null) {
      throw new Error(
        `Input "${name}" is optional but no default value was provided`
      )
    }
    // Return the default without running the converter.
    core.info(`For name "${name}", using default value of: ${actualDefault}`)
    return actualDefault as T
  }

  // If a value is provided, attempt conversion.
  try {
    return converter(rawValue)
  } catch (err) {
    throw new Error(
      `Input "${name}" with value "${rawValue}" failed conversion: ${(err as Error).message}`
    )
  }
}

/**
 * Retrieves a numeric input.
 */
export function getNumber(
  name: string,
  required = true,
  defaults: Record<string, any> | null = null
): number {
  return getGeneric<number>(
    name,
    (raw) => {
      const parsed = Number(raw)
      if (isNaN(parsed)) {
        throw new Error(
          `Input "${name}" with value "${raw}" is not a valid number`
        )
      }
      return parsed
    },
    required,
    defaults
  )
}

/**
 * Retrieves a string input.
 */
export function getString(
  name: string,
  required = true,
  defaults: Record<string, any> | null = null
): string {
  return getGeneric<string>(name, (raw) => raw, required, defaults)
}

/**
 * Retrieves an input as a string array (splitting on whitespace).
 */
export function getStringArray(
  name: string,
  required = true,
  defaults: Record<string, any> | null = null
): string[] {
  return getGeneric<string[]>(
    name,
    (raw) => raw.split(/\s+/).filter((str) => str.length > 0),
    required,
    defaults
  )
}
