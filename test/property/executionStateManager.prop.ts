import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Feature: ui-iteration-v05, Property 5: Execution state machine validity

/**
 * Property-based tests for ExecutionStateManager
 * Property 5: Execution state machine validity
 *
 * Validates: Requirements 3.1, 3.3, 3.7
 *
 * For any sequence of events (startExecution, requestCancel, completeExecution, removeEditor)
 * applied to an ExecutionStateManager, the state for each editor URI SHALL always be one of
 * 'idle', 'executing', or 'canceling', and:
 * - startExecution transitions from idle to executing (no-op otherwise)
 * - requestCancel transitions from executing to canceling (no-op otherwise)
 * - completeExecution transitions from executing or canceling to idle
 * - removeEditor removes the entry entirely (getState returns 'idle')
 * - Multiple editors maintain independent states
 */

// Mock vscode module (EventEmitter)
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
  return { EventEmitter };
});

import { ExecutionStateManager } from '../../src/executionStateManager';
import { ExecutionState } from '../../src/types';

// --- Types ---

type CommandType = 'start' | 'cancel' | 'complete' | 'remove';

interface Command {
  type: CommandType;
  editorUri: string;
}

// --- Generators ---

/** Generator: random editor URIs (small set to ensure collisions and test independence) */
const arbitraryEditorUri: fc.Arbitrary<string> = fc.oneof(
  fc.constant('file:///editor-a.sql'),
  fc.constant('file:///editor-b.sql'),
  fc.constant('file:///editor-c.sql'),
  fc.constant('file:///editor-d.sql')
);

/** Generator: random command type */
const arbitraryCommandType: fc.Arbitrary<CommandType> = fc.oneof(
  fc.constant('start' as CommandType),
  fc.constant('cancel' as CommandType),
  fc.constant('complete' as CommandType),
  fc.constant('remove' as CommandType)
);

/** Generator: a single command */
const arbitraryCommand: fc.Arbitrary<Command> = fc.record({
  type: arbitraryCommandType,
  editorUri: arbitraryEditorUri,
});

/** Generator: a sequence of commands (1 to 50 commands) */
const arbitraryCommandSequence: fc.Arbitrary<Command[]> = fc.array(arbitraryCommand, { minLength: 1, maxLength: 50 });

// --- Model (reference implementation for comparison) ---

/**
 * Simple model that tracks expected state per editor URI.
 * Applies the same transition rules as the real implementation.
 */
function modelTransition(currentState: ExecutionState, commandType: CommandType): ExecutionState | 'removed' {
  switch (commandType) {
    case 'start':
      return currentState === 'idle' ? 'executing' : currentState;
    case 'cancel':
      return currentState === 'executing' ? 'canceling' : currentState;
    case 'complete':
      return (currentState === 'executing' || currentState === 'canceling') ? 'idle' : currentState;
    case 'remove':
      return 'removed';
  }
}

// --- Tests ---

describe('ExecutionStateManager Property Tests', () => {
  // Feature: ui-iteration-v05, Property 5: Execution state machine validity

  let manager: ExecutionStateManager;

  beforeEach(() => {
    manager = new ExecutionStateManager();
  });

  describe('Property 5: Execution state machine validity', () => {
    /**
     * Validates: Requirements 3.1, 3.3, 3.7
     */

    it('state is always one of idle, executing, or canceling after any command sequence', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, (commands) => {
          const mgr = new ExecutionStateManager();
          const validStates: ExecutionState[] = ['idle', 'executing', 'canceling'];

          for (const cmd of commands) {
            // Apply command
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }

            // After each command, verify state is valid
            const state = mgr.getState(cmd.editorUri);
            expect(validStates).toContain(state);
          }

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });

    it('startExecution transitions from idle to executing (no-op otherwise)', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, arbitraryEditorUri, (commands, targetUri) => {
          const mgr = new ExecutionStateManager();

          // Apply commands to build up some state
          for (const cmd of commands) {
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }
          }

          // Now test startExecution on the target URI
          const stateBefore = mgr.getState(targetUri);
          mgr.startExecution(targetUri, () => {});
          const stateAfter = mgr.getState(targetUri);

          if (stateBefore === 'idle') {
            expect(stateAfter).toBe('executing');
          } else {
            // No-op: state should remain unchanged
            expect(stateAfter).toBe(stateBefore);
          }

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });

    it('requestCancel transitions from executing to canceling (no-op otherwise)', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, arbitraryEditorUri, (commands, targetUri) => {
          const mgr = new ExecutionStateManager();

          // Apply commands to build up some state
          for (const cmd of commands) {
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }
          }

          // Now test requestCancel on the target URI
          const stateBefore = mgr.getState(targetUri);
          mgr.requestCancel(targetUri);
          const stateAfter = mgr.getState(targetUri);

          if (stateBefore === 'executing') {
            expect(stateAfter).toBe('canceling');
          } else {
            // No-op: state should remain unchanged
            expect(stateAfter).toBe(stateBefore);
          }

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });

    it('completeExecution transitions from executing or canceling to idle', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, arbitraryEditorUri, (commands, targetUri) => {
          const mgr = new ExecutionStateManager();

          // Apply commands to build up some state
          for (const cmd of commands) {
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }
          }

          // Now test completeExecution on the target URI
          const stateBefore = mgr.getState(targetUri);
          mgr.completeExecution(targetUri);
          const stateAfter = mgr.getState(targetUri);

          if (stateBefore === 'executing' || stateBefore === 'canceling') {
            expect(stateAfter).toBe('idle');
          } else {
            // No-op when already idle
            expect(stateAfter).toBe('idle');
          }

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });

    it('removeEditor removes the entry entirely (getState returns idle)', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, arbitraryEditorUri, (commands, targetUri) => {
          const mgr = new ExecutionStateManager();

          // Apply commands to build up some state
          for (const cmd of commands) {
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }
          }

          // Now test removeEditor on the target URI
          mgr.removeEditor(targetUri);
          const stateAfter = mgr.getState(targetUri);

          // After removal, getState should return 'idle'
          expect(stateAfter).toBe('idle');

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });

    it('multiple editors maintain independent states', () => {
      fc.assert(
        fc.property(arbitraryCommandSequence, (commands) => {
          const mgr = new ExecutionStateManager();
          // Track expected state per editor using the model
          const expectedStates = new Map<string, ExecutionState>();

          for (const cmd of commands) {
            const currentExpected = expectedStates.get(cmd.editorUri) ?? 'idle';

            // Apply command to real manager
            switch (cmd.type) {
              case 'start':
                mgr.startExecution(cmd.editorUri, () => {});
                break;
              case 'cancel':
                mgr.requestCancel(cmd.editorUri);
                break;
              case 'complete':
                mgr.completeExecution(cmd.editorUri);
                break;
              case 'remove':
                mgr.removeEditor(cmd.editorUri);
                break;
            }

            // Apply command to model
            const result = modelTransition(currentExpected, cmd.type);
            if (result === 'removed') {
              expectedStates.delete(cmd.editorUri);
            } else {
              expectedStates.set(cmd.editorUri, result);
            }

            // Verify the actual state matches the model for the affected editor
            const actualState = mgr.getState(cmd.editorUri);
            const modelState = expectedStates.get(cmd.editorUri) ?? 'idle';
            expect(actualState).toBe(modelState);
          }

          // After all commands, verify all tracked editors match the model
          const allUris = new Set([
            'file:///editor-a.sql',
            'file:///editor-b.sql',
            'file:///editor-c.sql',
            'file:///editor-d.sql',
          ]);

          for (const uri of allUris) {
            const actualState = mgr.getState(uri);
            const modelState = expectedStates.get(uri) ?? 'idle';
            expect(actualState).toBe(modelState);
          }

          mgr.dispose();
        }),
        { numRuns: 100 }
      );
    });
  });
});
