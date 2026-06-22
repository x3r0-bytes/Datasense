/**
 * AliasGenerator — Produces short, deterministic table aliases from table names.
 *
 * Algorithm:
 * 1. Strip non-ASCII-alphanumeric characters
 * 2. Detect word boundaries (underscore separators, PascalCase transitions)
 * 3. Take first letter of each word, lowercase
 * 4. Default to 't' if derivation produces empty string
 * 5. Truncate to 10 chars max
 * 6. Resolve conflicts with existing aliases via numeric/alphabetic suffixes
 *
 * Output always matches /^[a-z0-9]{1,10}$/
 */

/**
 * Detects word boundaries in a cleaned table name and returns the words.
 *
 * Word boundaries are:
 * - Underscore separators: split on '_'
 * - PascalCase transitions:
 *   - lowercase → uppercase (e.g., "orderDetails" → ["order", "Details"])
 *   - uppercase → uppercase+lowercase (e.g., "XMLParser" → ["XML", "Parser"])
 */
function detectWords(cleaned: string): string[] {
  // First split on underscores
  const underscoreParts = cleaned.split('_').filter(part => part.length > 0);

  const words: string[] = [];

  for (const part of underscoreParts) {
    // Apply PascalCase splitting within each underscore-separated part
    let currentWord = '';

    for (let i = 0; i < part.length; i++) {
      const char = part[i];
      const isUpper = char >= 'A' && char <= 'Z';
      const isLower = char >= 'a' && char <= 'z';
      const prevChar = i > 0 ? part[i - 1] : '';
      const prevIsLower = prevChar >= 'a' && prevChar <= 'z';
      const prevIsUpper = prevChar >= 'A' && prevChar <= 'Z';
      const nextChar = i + 1 < part.length ? part[i + 1] : '';
      const nextIsLower = nextChar >= 'a' && nextChar <= 'z';

      if (i === 0) {
        currentWord = char;
      } else if (isUpper && prevIsLower) {
        // Transition: lowercase → uppercase (e.g., "orderD" → new word at "D")
        words.push(currentWord);
        currentWord = char;
      } else if (isUpper && prevIsUpper && nextIsLower) {
        // Transition: uppercase → uppercase+lowercase (e.g., "XMLParser" → "XML" ends, "P" starts)
        words.push(currentWord);
        currentWord = char;
      } else {
        currentWord += char;
      }
    }

    if (currentWord.length > 0) {
      words.push(currentWord);
    }
  }

  return words;
}

/**
 * Derives the base alias from a table name.
 *
 * - Strips non-ASCII-alphanumeric characters
 * - Detects word boundaries
 * - Takes first letter of each word, lowercased
 * - Single-word names use first letter only
 * - Returns empty string if no valid characters remain
 */
function deriveBaseAlias(tableName: string): string {
  // Strip non-ASCII-alphanumeric characters (keep only a-z, A-Z, 0-9, and _ for splitting)
  // First, replace underscores with a placeholder to preserve them for word splitting
  // Then strip everything that isn't ASCII alphanumeric or underscore
  const cleaned = tableName.replace(/[^a-zA-Z0-9_]/g, '');

  if (cleaned.length === 0) {
    return '';
  }

  const words = detectWords(cleaned);

  if (words.length === 0) {
    return '';
  }

  // Take first letter of each word, lowercase
  const alias = words.map(w => w[0].toLowerCase()).join('');

  return alias;
}

/**
 * Generates a unique, short alias for a table name that does not conflict
 * with any existing aliases.
 *
 * @param tableName - The table name to derive an alias from
 * @param existingAliases - Array of aliases already in use (case-insensitive comparison)
 * @returns A unique alias matching /^[a-z0-9]{1,10}$/
 */
export function generateAlias(
  tableName: string,
  existingAliases: string[]
): string {
  // Normalize existing aliases to lowercase for case-insensitive comparison
  const existingSet = new Set(existingAliases.map(a => a.toLowerCase()));

  // Step 1-3: Derive base alias
  let base = deriveBaseAlias(tableName);

  // Step 4: Default to 't' if empty
  if (base.length === 0) {
    base = 't';
  }

  // Step 5: Truncate to 10 chars
  if (base.length > 10) {
    base = base.substring(0, 10);
  }

  // Step 6: Conflict resolution
  // Try the base alias first
  if (!existingSet.has(base)) {
    return base;
  }

  // Try appending numeric suffix 2-99
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}${i}`;
    // Truncate to 10 chars if needed
    const truncated = candidate.substring(0, 10);
    if (!existingSet.has(truncated)) {
      return truncated;
    }
  }

  // If all 2-99 exhausted for original base, use 't' as base
  if (base !== 't') {
    if (!existingSet.has('t')) {
      return 't';
    }

    for (let i = 2; i <= 99; i++) {
      const candidate = `t${i}`;
      if (!existingSet.has(candidate)) {
        return candidate;
      }
    }
  }

  // If 't' through 't99' are also exhausted, use alphabetic suffixes 'ta'-'tz'
  for (let c = 97; c <= 122; c++) { // 'a' to 'z'
    const candidate = `t${String.fromCharCode(c)}`;
    if (!existingSet.has(candidate)) {
      return candidate;
    }
  }

  // Final fallback — should never reach here in practice given 26 alphabetic options
  // but return 't' to satisfy the contract
  return 't';
}
