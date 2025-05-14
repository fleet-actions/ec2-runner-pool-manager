/**
 * Example:
 *   matchInstanceType([c* m* r*],  "c6i.large")   - true
 *   matchInstanceType([c6i.large], "c6i.large")   - true
 *   matchInstanceType([c* r*],     "t4g.micro")   - false
 *
 * Pattern rules (same as AWS):
 *   • *  = any sequence of characters (possibly empty)
 *   • everything else is taken literally
 *
 * @param patterns      A single string array, e.g. ["c*", "m*", "r*"]
 * @param instanceType  The value to test, e.g. "c6i.large"
 * @returns             true if at least one pattern matches, otherwise false
 */
export function matchWildcardPatterns(
  patterns: string[],
  instanceType: string
): boolean {
  // Split the input on whitespace OR commas, drop empties
  const patternList = patterns

  // Return true as soon as something matches
  return patternList.some((pat) => {
    // Escape RegExp meta‑chars ( . + ? ^ $ { } ( ) | [ ] \ )
    const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // Convert * → .*  and anchor the pattern to the start/end of the string
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i')
    return regex.test(instanceType)
  })
}

// /* ─────────── quick demo ─────────── */
// console.log(matchInstanceType('c* m* r*', 'c6i.large')) // true
// console.log(matchInstanceType('c6i.large', 'c6i.large')) // true
// console.log(matchInstanceType('c* r*', 't4g.micro')) // false
