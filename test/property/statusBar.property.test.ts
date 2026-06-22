import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import type { ConnectionConfig } from '../../src/types';

/**
 * Property-based tests for Status Bar display (Properties 16-17)
 * Validates: Requirements 4.5, 4.6, 4.11
 */

// Mock vscode module
const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  backgroundColor: undefined as any,
  show: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: class ThemeColor {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
}));

import { StatusBar } from '../../src/statusBar';

// --- Generators ---

/** Generator: random valid SQL identifier (starts with letter/underscore, alphanumeric) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')
      ),
      { minLength: 0, maxLength: 20 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random connection name (human-readable, non-empty) */
const arbitraryConnectionName: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  )
  .filter((s) => s.trim().length > 0);

/** Generator: random hostname */
const arbitraryHost: fc.Arbitrary<string> = fc.oneof(
  fc.constant('localhost'),
  arbitraryIdentifier.map((id) => `${id}.local`),
  fc
    .tuple(
      fc.integer({ min: 1, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 255 })
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`)
);

/** Generator: random valid ConnectionConfig */
const arbitraryConnectionConfig: fc.Arbitrary<ConnectionConfig> = fc.record({
  name: arbitraryConnectionName,
  host: arbitraryHost,
  port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  database: arbitraryIdentifier,
  user: fc.option(arbitraryIdentifier, { nil: undefined }),
  password: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  encrypt: fc.option(fc.boolean(), { nil: undefined }),
  trustServerCertificate: fc.option(fc.boolean(), { nil: undefined }),
});

// --- Tests ---

describe('Status Bar Property Tests', () => {
  let statusBar: StatusBar;

  beforeEach(() => {
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';
    mockStatusBarItem.backgroundColor = undefined;
    mockStatusBarItem.show.mockClear();
    mockStatusBarItem.dispose.mockClear();
    statusBar = new StatusBar();
  });

  describe('Property 16: Status bar display format', () => {
    /**
     * Validates: Requirements 4.6, 4.11
     *
     * For any valid ConnectionConfig, the status bar text should always be
     * formatted as "$(database) {name} ({database})".
     * When config is null, it should display "$(database) No SQL Connection".
     */
    it('displays "$(database) {name} ({database})" for any valid ConnectionConfig', () => {
      fc.assert(
        fc.property(arbitraryConnectionConfig, (config) => {
          statusBar.update(config);

          const expectedText = `$(database) ${config.name} (${config.database})`;
          expect(mockStatusBarItem.text).toBe(expectedText);
        }),
        { numRuns: 200 }
      );
    });

    it('displays "$(database) No SQL Connection" when config is null', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          statusBar.update(null);

          expect(mockStatusBarItem.text).toBe('$(database) No SQL Connection');
        }),
        { numRuns: 10 }
      );
    });
  });

  describe('Property 17: Switch connection list display', () => {
    /**
     * Validates: Requirements 4.5
     *
     * For any list of ConnectionConfig items, the status bar should correctly
     * display the active connection's name and database after switching.
     */
    it('correctly displays each connection name and database after switching', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryConnectionConfig, { minLength: 1, maxLength: 10 }),
          fc.nat(),
          (configs, indexSeed) => {
            // Pick a random connection from the list
            const index = indexSeed % configs.length;
            const activeConfig = configs[index];

            // Simulate switching to this connection by updating the status bar
            statusBar.update(activeConfig);

            // The status bar should display the active connection's name and database
            expect(mockStatusBarItem.text).toContain(activeConfig.name);
            expect(mockStatusBarItem.text).toContain(activeConfig.database);
            expect(mockStatusBarItem.text).toBe(
              `$(database) ${activeConfig.name} (${activeConfig.database})`
            );
          }
        ),
        { numRuns: 200 }
      );
    });

    it('each connection in a list produces a distinct display when active', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryConnectionConfig, { minLength: 2, maxLength: 10 }).filter(
            (configs) => {
              // Ensure at least two configs produce different display strings
              const displays = new Set(
                configs.map((c) => `$(database) ${c.name} (${c.database})`)
              );
              return displays.size >= 2;
            }
          ),
          (configs) => {
            const displayTexts: string[] = [];

            for (const config of configs) {
              statusBar.update(config);
              displayTexts.push(mockStatusBarItem.text);
            }

            // Each config should produce a display containing its name and database
            for (let i = 0; i < configs.length; i++) {
              expect(displayTexts[i]).toBe(
                `$(database) ${configs[i].name} (${configs[i].database})`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
