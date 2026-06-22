import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validate, isDisplayNameUnique } from '../../src/objectExplorer/connectionFormValidator';
import { ConnectionFormInput } from '../../src/objectExplorer/types';

/**
 * Property-based tests for connection form validator
 * Feature: object-explorer-panel
 *
 * Property 1: Connection form validation rejects missing required fields
 * Validates: Requirements 3.4
 *
 * Property 3: Display name uniqueness is case-insensitive
 * Validates: Requirements 3.7
 */

// --- Generators (Property 1) ---

/** Generator: empty or whitespace-only string (simulates missing required field) */
const arbitraryEmptyOrWhitespace: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 10 })
);

/** Generator: non-empty string that is not all whitespace (valid field value) */
const arbitraryNonEmptyString: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([first, rest]) => first + rest);

/** Generator: valid display name (non-empty, max 128 chars after trim) */
const arbitraryValidDisplayName: fc.Arbitrary<string> = arbitraryNonEmptyString.filter(
  (s) => s.trim().length > 0 && s.trim().length <= 128
);

/** Generator: valid server name (non-empty after trim) */
const arbitraryValidServerName: fc.Arbitrary<string> = arbitraryNonEmptyString.filter(
  (s) => s.trim().length > 0
);

// --- Generators (Property 3) ---

/** Generator: a non-empty display name string */
const arbitraryDisplayName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-'.split('')
  ),
  { minLength: 1, maxLength: 30 }
);

/**
 * Generator: produces a name and a case-variant of that name (different casing).
 * Used to verify that case-insensitive matching detects duplicates.
 */
const arbitraryNameWithCaseVariant: fc.Arbitrary<{ original: string; variant: string }> = arbitraryDisplayName
  .filter((name) => name.toLowerCase() !== name || name.toUpperCase() !== name)
  .map((name) => {
    // Create a variant with toggled case
    const variant = name
      .split('')
      .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
      .join('');
    return { original: name, variant };
  });

/**
 * Generator: a list of existing names that does NOT contain the candidate (case-insensitive).
 */
const arbitraryNonMatchingList = (candidate: string): fc.Arbitrary<string[]> =>
  fc.array(arbitraryDisplayName, { minLength: 0, maxLength: 10 }).map((names) =>
    names.filter((n) => n.toLowerCase() !== candidate.toLowerCase())
  );

// --- Tests ---

describe('Connection Form Validator Property Tests', () => {
  describe('Feature: object-explorer-panel, Property 1: Connection form validation rejects missing required fields', () => {
    /**
     * Validates: Requirements 3.4
     *
     * For any ConnectionFormInput where the server name is empty, the display name is empty,
     * or (when authType is 'sql') the username or password is empty, the validate() function
     * SHALL return a ValidationResult with valid: false and an error entry identifying each
     * missing required field.
     */

    it('rejects inputs with empty/whitespace server name', () => {
      fc.assert(
        fc.property(
          arbitraryEmptyOrWhitespace,
          arbitraryValidDisplayName,
          fc.boolean(),
          fc.boolean(),
          (emptyServerName, displayName, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'windows',
              serverName: emptyServerName,
              displayName,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'serverName')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rejects inputs with empty/whitespace display name', () => {
      fc.assert(
        fc.property(
          arbitraryValidServerName,
          arbitraryEmptyOrWhitespace,
          fc.boolean(),
          fc.boolean(),
          (serverName, emptyDisplayName, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'windows',
              serverName,
              displayName: emptyDisplayName,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'displayName')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rejects SQL auth inputs with empty/whitespace username', () => {
      fc.assert(
        fc.property(
          arbitraryValidServerName,
          arbitraryValidDisplayName,
          arbitraryEmptyOrWhitespace,
          arbitraryNonEmptyString,
          fc.boolean(),
          fc.boolean(),
          (serverName, displayName, emptyUsername, password, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'sql',
              serverName,
              displayName,
              username: emptyUsername,
              password,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'username')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rejects SQL auth inputs with empty/whitespace password', () => {
      fc.assert(
        fc.property(
          arbitraryValidServerName,
          arbitraryValidDisplayName,
          arbitraryNonEmptyString,
          arbitraryEmptyOrWhitespace,
          fc.boolean(),
          fc.boolean(),
          (serverName, displayName, username, emptyPassword, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'sql',
              serverName,
              displayName,
              username,
              password: emptyPassword,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'password')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rejects SQL auth inputs with both username and password missing', () => {
      fc.assert(
        fc.property(
          arbitraryValidServerName,
          arbitraryValidDisplayName,
          arbitraryEmptyOrWhitespace,
          arbitraryEmptyOrWhitespace,
          fc.boolean(),
          fc.boolean(),
          (serverName, displayName, emptyUsername, emptyPassword, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'sql',
              serverName,
              displayName,
              username: emptyUsername,
              password: emptyPassword,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'username')).toBe(true);
            expect(result.errors.some((e) => e.field === 'password')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('rejects inputs with multiple missing required fields simultaneously', () => {
      fc.assert(
        fc.property(
          arbitraryEmptyOrWhitespace,
          arbitraryEmptyOrWhitespace,
          arbitraryEmptyOrWhitespace,
          arbitraryEmptyOrWhitespace,
          fc.boolean(),
          fc.boolean(),
          (emptyServer, emptyDisplay, emptyUser, emptyPass, encrypt, trustCert) => {
            const input: ConnectionFormInput = {
              authType: 'sql',
              serverName: emptyServer,
              displayName: emptyDisplay,
              username: emptyUser,
              password: emptyPass,
              encrypt,
              trustServerCertificate: trustCert,
            };

            const result = validate(input);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === 'serverName')).toBe(true);
            expect(result.errors.some((e) => e.field === 'displayName')).toBe(true);
            expect(result.errors.some((e) => e.field === 'username')).toBe(true);
            expect(result.errors.some((e) => e.field === 'password')).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Display name uniqueness is case-insensitive', () => {
    /**
     * Validates: Requirements 3.7
     *
     * For any candidate display name and any list of existing display names,
     * isDisplayNameUnique() SHALL return false if and only if the candidate
     * matches an existing name under case-insensitive comparison.
     */

    it('returns false when the existing list contains the candidate with different casing', () => {
      fc.assert(
        fc.property(
          arbitraryNameWithCaseVariant,
          fc.array(arbitraryDisplayName, { minLength: 0, maxLength: 5 }),
          ({ original, variant }, otherNames) => {
            // Build existing list with the case-variant included
            const existing = [...otherNames, variant];
            const result = isDisplayNameUnique(original, existing);
            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns false when the existing list contains the exact candidate', () => {
      fc.assert(
        fc.property(
          arbitraryDisplayName,
          fc.array(arbitraryDisplayName, { minLength: 0, maxLength: 5 }),
          (candidate, otherNames) => {
            // Include the exact candidate in the existing list
            const existing = [...otherNames, candidate];
            const result = isDisplayNameUnique(candidate, existing);
            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns true when the existing list does NOT contain the candidate (case-insensitive)', () => {
      fc.assert(
        fc.property(
          arbitraryDisplayName,
          arbitraryDisplayName.chain((candidate) => arbitraryNonMatchingList(candidate).map((list) => ({ candidate, list }))),
          (_, { candidate, list }) => {
            const result = isDisplayNameUnique(candidate, list);
            expect(result).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
