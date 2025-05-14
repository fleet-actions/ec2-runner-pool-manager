import { matchWildcardPatterns } from '../../../../src/provision/selection/utils/match-wildcard-patterns' // Adjust the import path as needed

describe('matchWildcardPatterns', () => {
  // Test cases from the function's example documentation
  it('should return true for "c*", "m*", "r*" and "c6i.large"', () => {
    expect(matchWildcardPatterns(['c*', 'm*', 'r*'], 'c6i.large')).toBe(true)
  })

  it('should return true for "c6i.large" and "c6i.large"', () => {
    expect(matchWildcardPatterns(['c6i.large'], 'c6i.large')).toBe(true)
  })

  it('should return false for "c*", "r*" and "t4g.micro"', () => {
    expect(matchWildcardPatterns(['c*', 'r*'], 't4g.micro')).toBe(false)
  })

  // Additional test cases
  it('should return false for an empty patterns array', () => {
    expect(matchWildcardPatterns([], 'c6i.large')).toBe(false)
  })

  it('should return false for a pattern list with only an empty string when instanceType is not empty', () => {
    expect(matchWildcardPatterns([''], 'c6i.large')).toBe(false)
  })

  it('should return true for a pattern list with an empty string when instanceType is also empty', () => {
    expect(matchWildcardPatterns([''], '')).toBe(true)
  })

  it('should return true if any pattern is a single wildcard "*"', () => {
    expect(matchWildcardPatterns(['*'], 'anything')).toBe(true)
    expect(matchWildcardPatterns(['a*', '*'], 'anything')).toBe(true)
  })

  it('should return true for a single wildcard "*" and an empty instanceType', () => {
    expect(matchWildcardPatterns(['*'], '')).toBe(true)
  })

  it('should handle wildcards in the middle of a pattern', () => {
    expect(matchWildcardPatterns(['c*large'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['c*i.large'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['c*g'], 'c6i.large')).toBe(false)
  })

  it('should return false for a non-matching pattern without wildcards', () => {
    expect(matchWildcardPatterns(['c6i.medium'], 'c6i.large')).toBe(false)
  })

  it('should return true if at least one pattern in a list matches', () => {
    expect(matchWildcardPatterns(['a*', 'b*', 'c*large'], 'c6i.large')).toBe(
      true
    )
  })

  it('should return false if no patterns in a list match', () => {
    expect(matchWildcardPatterns(['a*', 'b*', 'd*'], 'c6i.large')).toBe(false)
  })

  it('should be case-insensitive', () => {
    expect(matchWildcardPatterns(['C*'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['c*'], 'C6I.LARGE')).toBe(true)
    expect(matchWildcardPatterns(['C6I.LARGE'], 'c6i.large')).toBe(true)
  })

  it('should correctly handle patterns with characters that are special in regex', () => {
    expect(matchWildcardPatterns(['t2.micro'], 't2.micro')).toBe(true)
    expect(matchWildcardPatterns(['t2.*'], 't2.micro')).toBe(true) // This tests if the literal dot is handled
    expect(matchWildcardPatterns(['t2.mic*'], 't2.micro')).toBe(true)
  })

  it('should handle more complex wildcard scenarios', () => {
    expect(matchWildcardPatterns(['*.*'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['c6i.*'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['*.large'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['*i.lar*'], 'c6i.large')).toBe(true)
  })

  it('should return false when pattern is more specific than instance type', () => {
    expect(matchWildcardPatterns(['c6i.large.extra'], 'c6i.large')).toBe(false)
  })

  it('should handle multiple asterisks', () => {
    expect(matchWildcardPatterns(['c*i*large'], 'c6i.large')).toBe(true)
    expect(matchWildcardPatterns(['c**large'], 'c6i.large')).toBe(true) // Equivalent to c*large
  })

  it('should correctly match when instanceType contains special regex characters', () => {
    // The function escapes patterns, not the instanceType, which is correct.
    // This test ensures that a literal '.' in instanceType is treated as a literal.
    expect(matchWildcardPatterns(['instance.type'], 'instance.type')).toBe(true)
    expect(matchWildcardPatterns(['instance*type'], 'instance.type')).toBe(true)
    expect(matchWildcardPatterns(['i*.t*e'], 'instance.type')).toBe(true)
    expect(
      matchWildcardPatterns(['instance.type*'], 'instance.type.beta')
    ).toBe(true)
  })

  it('should return false for non-matching patterns where instanceType has special chars', () => {
    expect(matchWildcardPatterns(['instanceXtype'], 'instance.type')).toBe(
      false
    )
  })
})
