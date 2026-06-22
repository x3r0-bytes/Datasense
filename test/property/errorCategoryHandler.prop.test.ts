// Feature: ui-iteration-v05, Property 4: Error notification rate limiting
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for ErrorCategoryHandler rate limiting (Property 4)
 * Validates: Requirements 2.10
 *
 * For any sequence of connection errors for the same connection name,
 * only the first error within each 5-second window SHALL produce a user-facing notification.
 * Subsequent errors within the same window SHALL be suppressed (logged only).
 * After 5 seconds pass, a new notification is allowed.
 */

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
  env: {
    openExternal: vi.fn().mockResolvedValue(true),
  },
  Uri: {
    parse: vi.fn((url: string) => ({ toString: () => url })),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as vscode from 'vscode';
import { ErrorCategoryHandler } from '../../src/errorCategoryHandler';
import { ConnectionConfig } from '../../src/types';

const RATE_LIMIT_WINDOW_MS = 5000;

// --- Generators ---

/** Generator: a connection name (non-empty string) */
const arbitraryConnectionName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_- '.split('')),
      { minLength: 0, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: a sequence of positive time deltas (in ms) representing intervals between errors */
const arbitraryTimeDeltas: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 0, max: 15000 }),
  { minLength: 1, maxLength: 20 }
);

// --- Tests ---

describe('ErrorCategoryHandler Property Tests - Rate Limiting', () => {
  let handler: ErrorCategoryHandler;
  let mockOutputChannel: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockOutputChannel = {
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'SQL Server',
      replace: vi.fn(),
    };

    handler = new ErrorCategoryHandler(mockOutputChannel);
  });

  afterEach(() => {
    handler.dispose();
    vi.useRealTimers();
  });

  describe('Property 4: Error notification rate limiting', () => {
    /**
     * Validates: Requirements 2.10
     *
     * For any sequence of connection errors for the same connection name,
     * only the first error within each 5-second window SHALL produce a user-facing notification.
     * Subsequent errors within the same window SHALL be suppressed (logged only).
     * After 5 seconds pass, a new notification is allowed.
     */
    it('only the first error within each 5-second window produces a notification', () => {
      fc.assert(
        fc.property(
          arbitraryConnectionName,
          arbitraryTimeDeltas,
          (connectionName, timeDeltas) => {
            // Reset state for each property run
            vi.clearAllMocks();
            handler.dispose();
            handler = new ErrorCategoryHandler(mockOutputChannel);
            vi.setSystemTime(0);

            const config: ConnectionConfig = {
              name: connectionName,
              host: 'localhost',
              port: 1433,
            };

            const error = new Error('ECONNREFUSED connection refused');

            // Track which calls should produce a notification
            let expectedNotificationCount = 0;
            let lastNotificationTime = -Infinity;

            // Process each error at the cumulative time
            let currentTime = 0;
            for (const delta of timeDeltas) {
              currentTime += delta;
              vi.setSystemTime(currentTime);

              // Determine if this error should produce a notification
              const timeSinceLastNotification = currentTime - lastNotificationTime;
              if (timeSinceLastNotification >= RATE_LIMIT_WINDOW_MS) {
                expectedNotificationCount++;
                lastNotificationTime = currentTime;
              }

              // Call handleConnectionError (fire-and-forget since we use fake timers)
              handler.handleConnectionError(error, config);
            }

            // Verify: showErrorMessage called exactly expectedNotificationCount times
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(expectedNotificationCount);

            // Verify: all errors are logged (every call logs regardless of rate limiting)
            expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(timeDeltas.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('after 5 seconds pass from last notification, a new notification is allowed', () => {
      fc.assert(
        fc.property(
          arbitraryConnectionName,
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: RATE_LIMIT_WINDOW_MS, max: 20000 }),
          (connectionName, suppressedCount, gapAfterFirst) => {
            // Reset state
            vi.clearAllMocks();
            handler.dispose();
            handler = new ErrorCategoryHandler(mockOutputChannel);
            vi.setSystemTime(0);

            const config: ConnectionConfig = {
              name: connectionName,
              host: 'server1.example.com',
              port: 1433,
            };

            const error = new Error('ECONNREFUSED');

            // First error at time 0 — should produce notification
            handler.handleConnectionError(error, config);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

            // Suppressed errors within the 5-second window
            for (let i = 0; i < suppressedCount; i++) {
              const suppressedTime = Math.floor((i + 1) * (RATE_LIMIT_WINDOW_MS - 1) / (suppressedCount + 1));
              vi.setSystemTime(suppressedTime);
              handler.handleConnectionError(error, config);
            }

            // All suppressed — still only 1 notification
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

            // After the gap (>= 5 seconds from first notification), a new notification is allowed
            vi.setSystemTime(gapAfterFirst);
            handler.handleConnectionError(error, config);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('errors within the same 5-second window are suppressed but still logged', () => {
      fc.assert(
        fc.property(
          arbitraryConnectionName,
          fc.array(fc.integer({ min: 1, max: RATE_LIMIT_WINDOW_MS - 1 }), { minLength: 1, maxLength: 10 }),
          (connectionName, withinWindowDeltas) => {
            // Reset state
            vi.clearAllMocks();
            handler.dispose();
            handler = new ErrorCategoryHandler(mockOutputChannel);
            vi.setSystemTime(0);

            const config: ConnectionConfig = {
              name: connectionName,
              host: 'db-server',
              port: 5432,
            };

            const error = new Error('ETIMEOUT connection timed out');

            // First error — produces notification
            handler.handleConnectionError(error, config);

            // Subsequent errors within the window — suppressed
            let currentTime = 0;
            for (const delta of withinWindowDeltas) {
              currentTime += delta;
              if (currentTime >= RATE_LIMIT_WINDOW_MS) {
                // Don't exceed the window for this test
                break;
              }
              vi.setSystemTime(currentTime);
              handler.handleConnectionError(error, config);
            }

            // Only 1 notification shown
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

            // But all errors were logged (1 initial + however many within window)
            const totalCalls = mockOutputChannel.appendLine.mock.calls.length;
            expect(totalCalls).toBeGreaterThanOrEqual(2); // At least the first + one suppressed
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
