import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getObjectDefinition,
  resolveObjectNameFromString,
} from '../../server/src/definitionProvider';

/**
 * Property-based tests for DefinitionProvider (Properties 3, 4, 5)
 * Feature: next-iteration-v092
 *
 * Validates: Requirements 2.1, 2.2, 2.5, 2.8, 2.9
 */

// --- Generators ---

/** Supported type codes for definition retrieval */
const supportedTypeCodes = ['P', 'V', 'FN', 'IF', 'TF'] as const;

/** Maps type codes to expected objectType values */
const TYPE_MAP: Record<string, 'procedure' | 'view' | 'function'> = {
  'P': 'procedure',
  'V': 'view',
  'FN': 'function',
  'IF': 'function',
  'TF': 'function',
};

/** Generator: random supported type code */
const arbitraryTypeCode = fc.constantFrom(...supportedTypeCodes);

/** Generator: valid SQL identifier (starts with letter/underscore/#/@, then alphanumeric/_/#/@) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_#@'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_#@'.split('')),
      { minLength: 1, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: schema name (valid SQL identifier) */
const arbitrarySchemaName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 12 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random non-empty source text simulating SQL definitions */
const arbitrarySourceText: fc.Arbitrary<string> = fc
  .stringOf(fc.fullUnicode(), { minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Generator: database name (valid SQL identifier) */
const arbitraryDatabaseName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest);

// --- Mock helpers ---

/**
 * Creates a mock ConnectionPool that simulates SQL Server query behavior.
 * The mock returns configured type and definition results based on the queries made.
 */
function createMockPool(options: {
  typeCode: string;
  twoPartDefinition: string | null;
  threePartDefinition?: string | null;
}): any {
  return {
    request: () => {
      let inputParams: Record<string, any> = {};
      let queryCount = 0;

      const requestObj: any = {
        input: (name: string, _type: any, value: any) => {
          inputParams[name] = value;
          return requestObj;
        },
        query: async (sql: string) => {
          queryCount++;
          // First query: sys.objects type lookup
          if (sql.includes('sys.objects')) {
            return {
              recordset: [{ type: options.typeCode + '  ' }], // SQL Server pads type with spaces
            };
          }
          // Definition queries
          if (sql.includes('OBJECT_DEFINITION')) {
            // Determine if this is a three-part name retry
            if (inputParams['threePartName']) {
              return {
                recordset: [{ definition: options.threePartDefinition ?? null }],
              };
            }
            // Two-part name attempt
            return {
              recordset: [{ definition: options.twoPartDefinition }],
            };
          }
          return { recordset: [] };
        },
      };
      return requestObj;
    },
  };
}

/**
 * Creates a mock ConnectionPool where the object is NOT found in sys.objects.
 */
function createMockPoolNotFound(): any {
  return {
    request: () => {
      const requestObj: any = {
        input: (_name: string, _type: any, _value: any) => requestObj,
        query: async (sql: string) => {
          if (sql.includes('sys.objects')) {
            return { recordset: [] }; // Object not found
          }
          return { recordset: [] };
        },
      };
      return requestObj;
    },
  };
}

// --- Property Tests ---

describe('DefinitionProvider Property Tests', () => {
  describe('Property 3: Definition Provider Type and Source Retrieval', () => {
    /**
     * Feature: next-iteration-v092, Property 3: Definition Provider Type and Source Retrieval
     *
     * Validates: Requirements 2.1, 2.2, 2.8
     *
     * For any supported type code (P, V, FN, IF, TF) and any schema/objectName pair
     * where the database returns a non-null definition, getObjectDefinition() SHALL
     * return the correct objectType mapping and the exact source text from the database.
     */

    it('returns correct objectType mapping and exact source text for all supported type codes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryTypeCode,
          arbitrarySchemaName,
          arbitraryIdentifier,
          arbitrarySourceText,
          async (typeCode, schema, objectName, sourceText) => {
            const pool = createMockPool({
              typeCode,
              twoPartDefinition: sourceText,
            });

            const result = await getObjectDefinition(pool, schema, objectName);

            // Must return correct objectType mapping
            expect(result.objectType).toBe(TYPE_MAP[typeCode]);

            // Must return the exact source text
            expect(result.source).toBe(sourceText);

            // Must return the correct qualified name
            expect(result.qualifiedName).toBe(`${schema}.${objectName}`);

            // Must NOT have a reason (successful retrieval)
            expect(result.reason).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Three-Part Name Retry', () => {
    /**
     * Feature: next-iteration-v092, Property 4: Three-Part Name Retry
     *
     * Validates: Requirements 2.5
     *
     * For any schema/objectName/databaseName triple where the two-part OBJECT_ID
     * returns NULL but the three-part succeeds, getObjectDefinition() SHALL return
     * the source text from the retry attempt rather than reporting encrypted.
     */

    it('returns source text from three-part retry when two-part returns NULL', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryTypeCode,
          arbitrarySchemaName,
          arbitraryIdentifier,
          arbitraryDatabaseName,
          arbitrarySourceText,
          async (typeCode, schema, objectName, databaseName, retrySourceText) => {
            const pool = createMockPool({
              typeCode,
              twoPartDefinition: null, // Two-part returns NULL
              threePartDefinition: retrySourceText, // Three-part succeeds
            });

            const result = await getObjectDefinition(pool, schema, objectName, databaseName);

            // Must return the source text from the retry
            expect(result.source).toBe(retrySourceText);

            // Must return correct objectType mapping
            expect(result.objectType).toBe(TYPE_MAP[typeCode]);

            // Must return the correct qualified name
            expect(result.qualifiedName).toBe(`${schema}.${objectName}`);

            // Must NOT have a reason (successful retrieval)
            expect(result.reason).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns encrypted reason when both two-part and three-part return NULL', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryTypeCode,
          arbitrarySchemaName,
          arbitraryIdentifier,
          arbitraryDatabaseName,
          async (typeCode, schema, objectName, databaseName) => {
            const pool = createMockPool({
              typeCode,
              twoPartDefinition: null, // Two-part returns NULL
              threePartDefinition: null, // Three-part also returns NULL
            });

            const result = await getObjectDefinition(pool, schema, objectName, databaseName);

            // Must return null source
            expect(result.source).toBeNull();

            // Must return encrypted reason
            expect(result.reason).toBe('encrypted');

            // Must still return correct objectType
            expect(result.objectType).toBe(TYPE_MAP[typeCode]);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5: Object Name Resolution', () => {
    /**
     * Feature: next-iteration-v092, Property 5: Object Name Resolution
     *
     * Validates: Requirements 2.9
     *
     * For any valid SQL identifier string containing exactly one dot separator,
     * resolveObjectNameFromString() SHALL split it into {schema, name}. For any
     * valid unqualified identifier (no dot), it SHALL return {schema: 'dbo', name: identifier}.
     */

    it('splits schema-qualified names (one dot) into {schema, name}', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, name) => {
            const qualified = `${schema}.${name}`;
            const result = resolveObjectNameFromString(qualified);

            expect(result).not.toBeNull();
            expect(result!.schema).toBe(schema);
            expect(result!.name).toBe(name);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('defaults unqualified names to dbo schema', () => {
      fc.assert(
        fc.property(
          arbitraryIdentifier,
          (name) => {
            // Ensure the identifier does not contain a dot
            const cleanName = name.replace(/\./g, '');
            if (cleanName.length === 0 || !/^[a-zA-Z_#@][a-zA-Z0-9_#@]*$/.test(cleanName)) {
              return; // skip invalid identifiers
            }

            const result = resolveObjectNameFromString(cleanName);

            expect(result).not.toBeNull();
            expect(result!.schema).toBe('dbo');
            expect(result!.name).toBe(cleanName);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('handles special characters (# and @) in identifiers', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('#', '@', '_'),
          fc.stringOf(
            fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
            { minLength: 1, maxLength: 10 }
          ),
          (prefix, suffix) => {
            const name = `${prefix}${suffix}`;
            const result = resolveObjectNameFromString(name);

            expect(result).not.toBeNull();
            expect(result!.schema).toBe('dbo');
            expect(result!.name).toBe(name);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns null for empty or whitespace-only strings', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('', ' ', '  ', '\t', '\n'),
          (input) => {
            const result = resolveObjectNameFromString(input);
            expect(result).toBeNull();
          }
        ),
        { numRuns: 5 }
      );
    });
  });
});
