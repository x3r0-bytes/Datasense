import * as vscode from 'vscode';
import { ExecutionState, EditorExecutionEntry } from './types';

/**
 * Manages per-editor execution state machines.
 * Each editor URI has an independent state: idle, executing, or canceling.
 * Invalid transitions are silently ignored (no-ops).
 */
export class ExecutionStateManager implements vscode.Disposable {
  private readonly states = new Map<string, EditorExecutionEntry>();
  private readonly _onStateChanged = new vscode.EventEmitter<{ uri: string; state: ExecutionState }>();

  /** Fires when any editor's execution state changes. */
  public readonly onStateChanged: vscode.Event<{ uri: string; state: ExecutionState }> = this._onStateChanged.event;

  /**
   * Returns the current execution state for the given editor URI.
   * Returns 'idle' if no entry exists.
   */
  getState(editorUri: string): ExecutionState {
    const entry = this.states.get(editorUri);
    return entry ? entry.state : 'idle';
  }

  /**
   * Transitions from idle → executing.
   * Stores the cancel function for later use.
   * No-op if the current state is not idle.
   */
  startExecution(editorUri: string, cancelFn: () => void): void {
    const currentState = this.getState(editorUri);
    if (currentState !== 'idle') {
      return;
    }

    this.states.set(editorUri, { state: 'executing', cancelFn, startTime: Date.now() });
    this._onStateChanged.fire({ uri: editorUri, state: 'executing' });
  }

  /**
   * Transitions from executing → canceling.
   * Calls the stored cancel function.
   * No-op if the current state is not executing.
   */
  requestCancel(editorUri: string): void {
    const entry = this.states.get(editorUri);
    if (!entry || entry.state !== 'executing') {
      return;
    }

    const cancelFn = entry.cancelFn;
    entry.state = 'canceling';
    entry.cancelFn = null;
    this._onStateChanged.fire({ uri: editorUri, state: 'canceling' });

    if (cancelFn) {
      cancelFn();
    }
  }

  /**
   * Returns the start time (epoch ms) for the given editor's current execution.
   * Returns null if not executing or no entry exists.
   */
  getStartTime(editorUri: string): number | null {
    const entry = this.states.get(editorUri);
    return entry ? entry.startTime : null;
  }

  /**
   * Transitions from executing or canceling → idle.
   * Clears the cancel function.
   * No-op if the current state is idle.
   */
  completeExecution(editorUri: string): void {
    const entry = this.states.get(editorUri);
    if (!entry || entry.state === 'idle') {
      return;
    }

    entry.state = 'idle';
    entry.cancelFn = null;
    entry.startTime = null;
    this._onStateChanged.fire({ uri: editorUri, state: 'idle' });
  }

  /**
   * Removes the entry for the given editor URI entirely.
   * Used when an editor is closed.
   */
  removeEditor(editorUri: string): void {
    this.states.delete(editorUri);
  }

  /**
   * Disposes the event emitter.
   */
  dispose(): void {
    this._onStateChanged.dispose();
  }
}
