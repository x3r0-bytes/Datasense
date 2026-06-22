import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Feature: ui-iteration-v05, Property 10: CodeLens generation with threshold

/**
 * Property-based tests for StatementCodeLensProvider
 * Property 10: CodeLens generation with threshold
 *
 * Validates: Requirements 7.3, 7.6
 *
 * For any array of StatementBoundary objects, the statement CodeLens provider SHALL:
 * - Produce exactly one CodeLens per statement when the count is ≤ 500
 * - Produce zero CodeLens items when the count exceeds 500
 * - Place each CodeLens at the startLine of its corresponding statement
 */

// Mock vscode module
vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: any) {
      this.listeners.forEach(l => l(data));
    }
    dispose() {
      this.listeners = [];
    }
  }

  class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number
    ) {}
  }

  class CodeLens {
    constructor(public range: Range, public command?: any) {}
  }

  const workspace = {
    getConfiguration: (_section?: string) => ({
      get: <T>(key: string, defaultValue?: T): T => {
        // Mock showInlineRunButtons to return true by default
        if (key === 'showInlineRunButtons') {
          return true as unknown as T;
        }
        return defaultValue as T;
      },
    }),
  };

  return {
    EventEmitter,
    Range,
    CodeLens,
    workspace,
    CancellationTokenSource: class {
      token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    },
  };
});

import { StatementCodeLensProvider } from '../../src/statementCodeLensProvider';
import { StatementBoundary } from '../../src/types';

// --- Generators ---

/** Generator: a single StatementBoundary with random but valid fields */
const arbitraryStatementBoundary = (index: number): fc.Arbitrary<StatementBoundary> =>
  fc.record({
    startLine: fc.constant(index * 3),       // Ensure non-overlapping boundaries
    endLine: fc.constant(index * 3 + 1),
    text: fc.string({ minLength: 1, maxLength: 50 }).map(s => `SELECT ${s}`),
    batchIndex: fc.constant(1),
    statementIndex: fc.constant(index + 1),
  });

/** Generator: array of StatementBoundary objects with size 0 to 600+ */
const arbitraryBoundaryArray: fc.Arbitrary<StatementBoundary[]> = fc.integer({ min: 0, max: 700 }).chain(size =>
  fc.tuple(...Array.from({ length: size }, (_, i) => arbitraryStatementBoundary(i))).map(arr => arr)
);

/** Generator: array of boundaries specifically at or below threshold (0 to 500) */
const arbitraryBoundaryArrayBelowThreshold: fc.Arbitrary<StatementBoundary[]> = fc.integer({ min: 0, max: 500 }).chain(size =>
  size === 0
    ? fc.constant([] as StatementBoundary[])
    : fc.tuple(...Array.from({ length: size }, (_, i) => arbitraryStatementBoundary(i))).map(arr => arr)
);

/** Generator: array of boundaries above threshold (501 to 700) */
const arbitraryBoundaryArrayAboveThreshold: fc.Arbitrary<StatementBoundary[]> = fc.integer({ min: 501, max: 700 }).chain(size =>
  fc.tuple(...Array.from({ length: size }, (_, i) => arbitraryStatementBoundary(i))).map(arr => arr)
);

// --- Mock document and token ---

function createMockDocument(uri: string = 'file:///test.sql') {
  return {
    uri: { toString: () => uri },
    getText: () => '',
    lineCount: 2100,
  } as any;
}

function createMockToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as any;
}

// --- Tests ---

describe('StatementCodeLensProvider Property Tests', () => {
  // Feature: ui-iteration-v05, Property 10: CodeLens generation with threshold

  let provider: StatementCodeLensProvider;

  beforeEach(() => {
    provider = new StatementCodeLensProvider();
  });

  describe('Property 10: CodeLens generation with threshold', () => {
    /**
     * Validates: Requirements 7.3, 7.6
     */

    it('produces exactly one CodeLens per statement when count is ≤ 500', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArrayBelowThreshold, (boundaries) => {
          const prov = new StatementCodeLensProvider();
          prov.setBoundaries(boundaries);
          prov.setConnectionActive(true);

          const codeLenses = prov.provideCodeLenses(createMockDocument(), createMockToken());

          // Should produce exactly one CodeLens per boundary
          expect(codeLenses.length).toBe(boundaries.length);
        }),
        { numRuns: 100 }
      );
    });

    it('produces zero CodeLens items when count exceeds 500', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArrayAboveThreshold, (boundaries) => {
          const prov = new StatementCodeLensProvider();
          prov.setBoundaries(boundaries);
          prov.setConnectionActive(true);

          const codeLenses = prov.provideCodeLenses(createMockDocument(), createMockToken());

          // Should produce zero CodeLens items above threshold
          expect(codeLenses.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });

    it('places each CodeLens at the startLine of its corresponding statement', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArrayBelowThreshold, (boundaries) => {
          if (boundaries.length === 0) return; // Skip empty arrays

          const prov = new StatementCodeLensProvider();
          prov.setBoundaries(boundaries);
          prov.setConnectionActive(true);

          const codeLenses = prov.provideCodeLenses(createMockDocument(), createMockToken());

          // Each CodeLens should be placed at the startLine of its corresponding boundary
          for (let i = 0; i < boundaries.length; i++) {
            expect(codeLenses[i].range.startLine).toBe(boundaries[i].startLine);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('threshold behavior: exactly 500 boundaries produces CodeLens, 501 does not', () => {
      fc.assert(
        fc.property(fc.integer({ min: 490, max: 510 }), (size) => {
          const boundaries: StatementBoundary[] = Array.from({ length: size }, (_, i) => ({
            startLine: i * 2,
            endLine: i * 2 + 1,
            text: `SELECT ${i}`,
            batchIndex: 1,
            statementIndex: i + 1,
          }));

          const prov = new StatementCodeLensProvider();
          prov.setBoundaries(boundaries);
          prov.setConnectionActive(true);

          const codeLenses = prov.provideCodeLenses(createMockDocument(), createMockToken());

          if (size <= 500) {
            expect(codeLenses.length).toBe(size);
          } else {
            expect(codeLenses.length).toBe(0);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
