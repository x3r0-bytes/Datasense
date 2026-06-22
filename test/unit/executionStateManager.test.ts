import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  return { EventEmitter };
});

import { ExecutionStateManager } from '../../src/executionStateManager';

describe('ExecutionStateManager', () => {
  let manager: ExecutionStateManager;

  beforeEach(() => {
    manager = new ExecutionStateManager();
  });

  describe('getState', () => {
    it('returns idle for unknown editor URIs', () => {
      expect(manager.getState('file:///unknown.sql')).toBe('idle');
    });

    it('returns the current state after startExecution', () => {
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('executing');
    });
  });

  describe('startExecution', () => {
    it('transitions from idle to executing', () => {
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('executing');
    });

    it('is a no-op when already executing', () => {
      const cancelFn1 = vi.fn();
      const cancelFn2 = vi.fn();
      manager.startExecution('file:///test.sql', cancelFn1);
      manager.startExecution('file:///test.sql', cancelFn2);
      expect(manager.getState('file:///test.sql')).toBe('executing');
      // Original cancel function should still be in effect
      manager.requestCancel('file:///test.sql');
      expect(cancelFn1).toHaveBeenCalled();
      expect(cancelFn2).not.toHaveBeenCalled();
    });

    it('is a no-op when in canceling state', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.requestCancel('file:///test.sql');
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('canceling');
    });
  });

  describe('requestCancel', () => {
    it('transitions from executing to canceling', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.requestCancel('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('canceling');
    });

    it('calls the stored cancel function', () => {
      const cancelFn = vi.fn();
      manager.startExecution('file:///test.sql', cancelFn);
      manager.requestCancel('file:///test.sql');
      expect(cancelFn).toHaveBeenCalledOnce();
    });

    it('is a no-op when idle', () => {
      manager.requestCancel('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('is a no-op when already canceling', () => {
      const cancelFn = vi.fn();
      manager.startExecution('file:///test.sql', cancelFn);
      manager.requestCancel('file:///test.sql');
      cancelFn.mockClear();
      manager.requestCancel('file:///test.sql');
      expect(cancelFn).not.toHaveBeenCalled();
      expect(manager.getState('file:///test.sql')).toBe('canceling');
    });
  });

  describe('completeExecution', () => {
    it('transitions from executing to idle', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.completeExecution('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('transitions from canceling to idle', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.requestCancel('file:///test.sql');
      manager.completeExecution('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('is a no-op when already idle', () => {
      manager.completeExecution('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });
  });

  describe('getStartTime', () => {
    it('returns null for unknown editor URIs', () => {
      expect(manager.getStartTime('file:///unknown.sql')).toBeNull();
    });

    it('returns a timestamp after startExecution', () => {
      const before = Date.now();
      manager.startExecution('file:///test.sql', () => {});
      const after = Date.now();
      const startTime = manager.getStartTime('file:///test.sql');
      expect(startTime).toBeGreaterThanOrEqual(before);
      expect(startTime).toBeLessThanOrEqual(after);
    });

    it('returns null after completeExecution', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.completeExecution('file:///test.sql');
      expect(manager.getStartTime('file:///test.sql')).toBeNull();
    });
  });

  describe('removeEditor', () => {
    it('removes the entry for the editor', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.removeEditor('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('is safe to call for non-existent editors', () => {
      expect(() => manager.removeEditor('file:///nonexistent.sql')).not.toThrow();
    });
  });

  describe('onStateChanged', () => {
    it('fires when transitioning to executing', () => {
      const listener = vi.fn();
      manager.onStateChanged(listener);
      manager.startExecution('file:///test.sql', () => {});
      expect(listener).toHaveBeenCalledWith({ uri: 'file:///test.sql', state: 'executing' });
    });

    it('fires when transitioning to canceling', () => {
      const listener = vi.fn();
      manager.onStateChanged(listener);
      manager.startExecution('file:///test.sql', () => {});
      listener.mockClear();
      manager.requestCancel('file:///test.sql');
      expect(listener).toHaveBeenCalledWith({ uri: 'file:///test.sql', state: 'canceling' });
    });

    it('fires when transitioning to idle via completeExecution', () => {
      const listener = vi.fn();
      manager.onStateChanged(listener);
      manager.startExecution('file:///test.sql', () => {});
      listener.mockClear();
      manager.completeExecution('file:///test.sql');
      expect(listener).toHaveBeenCalledWith({ uri: 'file:///test.sql', state: 'idle' });
    });

    it('does not fire for no-op transitions', () => {
      const listener = vi.fn();
      manager.onStateChanged(listener);
      // requestCancel on idle is a no-op
      manager.requestCancel('file:///test.sql');
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire after dispose', () => {
      const listener = vi.fn();
      manager.onStateChanged(listener);
      manager.dispose();
      manager.startExecution('file:///test.sql', () => {});
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('per-editor isolation', () => {
    it('maintains independent states for different editors', () => {
      manager.startExecution('file:///a.sql', () => {});
      manager.startExecution('file:///b.sql', () => {});
      manager.requestCancel('file:///a.sql');

      expect(manager.getState('file:///a.sql')).toBe('canceling');
      expect(manager.getState('file:///b.sql')).toBe('executing');
    });

    it('completing one editor does not affect another', () => {
      manager.startExecution('file:///a.sql', () => {});
      manager.startExecution('file:///b.sql', () => {});
      manager.completeExecution('file:///a.sql');

      expect(manager.getState('file:///a.sql')).toBe('idle');
      expect(manager.getState('file:///b.sql')).toBe('executing');
    });

    it('removing one editor does not affect another', () => {
      manager.startExecution('file:///a.sql', () => {});
      manager.startExecution('file:///b.sql', () => {});
      manager.removeEditor('file:///a.sql');

      expect(manager.getState('file:///a.sql')).toBe('idle');
      expect(manager.getState('file:///b.sql')).toBe('executing');
    });
  });

  describe('full lifecycle', () => {
    it('supports idle → executing → idle cycle', () => {
      expect(manager.getState('file:///test.sql')).toBe('idle');
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('executing');
      manager.completeExecution('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('supports idle → executing → canceling → idle cycle', () => {
      expect(manager.getState('file:///test.sql')).toBe('idle');
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('executing');
      manager.requestCancel('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('canceling');
      manager.completeExecution('file:///test.sql');
      expect(manager.getState('file:///test.sql')).toBe('idle');
    });

    it('can restart execution after completion', () => {
      manager.startExecution('file:///test.sql', () => {});
      manager.completeExecution('file:///test.sql');
      manager.startExecution('file:///test.sql', () => {});
      expect(manager.getState('file:///test.sql')).toBe('executing');
    });
  });
});
