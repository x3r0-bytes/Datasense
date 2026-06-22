import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../src/types';

// Mock vscode module
const mockWebview = {
  options: {} as any,
  html: '',
  postMessage: vi.fn().mockResolvedValue(true),
  onDidReceiveMessage: vi.fn(),
  cspSource: '',
  asWebviewUri: vi.fn((uri: any) => uri),
};

const mockWebviewView = {
  webview: mockWebview,
  show: vi.fn(),
  onDidDispose: vi.fn(),
  visible: true,
  viewType: 'sqlServerResults',
};

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: 'file' }),
    joinPath: (...args: any[]) => ({ fsPath: args.join('/') }),
  },
  window: {},
  ViewColumn: { Beside: 2 },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import { ResultPanelProvider } from '../../src/resultPanelProvider';

describe('ResultPanelProvider', () => {
  let provider: ResultPanelProvider;
  const mockExtensionUri = { fsPath: '/test/extension', scheme: 'file' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebview.html = '';
    mockWebview.postMessage.mockResolvedValue(true);
    mockWebviewView.onDidDispose.mockImplementation(() => {});
    provider = new ResultPanelProvider(mockExtensionUri);
  });

  describe('static properties', () => {
    it('should have viewType set to sqlServerResults', () => {
      expect(ResultPanelProvider.viewType).toBe('sqlServerResults');
    });
  });

  describe('resolveWebviewView', () => {
    it('should set webview options with enableScripts', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.options.enableScripts).toBe(true);
    });

    it('should set initial HTML content', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.html).toContain('<!DOCTYPE html>');
      expect(mockWebview.html).toContain('Run a query to see results here.');
    });

    it('should use VS Code CSS variables for theming', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.html).toContain('--vscode-foreground');
      expect(mockWebview.html).toContain('--vscode-editor-background');
      expect(mockWebview.html).toContain('--vscode-panel-border');
    });

    it('should register onDidDispose handler', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebviewView.onDidDispose).toHaveBeenCalled();
    });

    it('should deliver pending message after resolve', () => {
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 5,
        executionTimeMs: 100,
      };

      // Send message before resolving
      provider.show(result);

      // Now resolve the webview
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });
  });

  describe('show', () => {
    beforeEach(() => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );
    });

    it('should post a data message with the query result', () => {
      const result: QueryResult = {
        resultSets: [
          {
            columns: [{ name: 'id', dataType: 'int' }],
            rows: [[1], [2], [3]],
            rowCount: 3,
          },
        ],
        rowsAffected: 0,
        executionTimeMs: 42,
      };

      provider.show(result);

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });

    it('should reveal the panel when showing results', () => {
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 1,
        executionTimeMs: 10,
      };

      provider.show(result);

      expect(mockWebviewView.show).toHaveBeenCalledWith(true);
    });

    it('should post error results correctly', () => {
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 0,
        executionTimeMs: 5,
        error: {
          number: 208,
          severity: 16,
          message: "Invalid object name 'foo'.",
        },
      };

      provider.show(result);

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });
  });

  describe('showProgress', () => {
    beforeEach(() => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );
    });

    it('should post a progress message', () => {
      provider.showProgress();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'progress',
      });
    });

    it('should reveal the panel', () => {
      provider.showProgress();

      expect(mockWebviewView.show).toHaveBeenCalledWith(true);
    });
  });

  describe('showCancellation', () => {
    beforeEach(() => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );
    });

    it('should post a cancelled message', () => {
      provider.showCancellation();

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'cancelled',
      });
    });

    it('should reveal the panel', () => {
      provider.showCancellation();

      expect(mockWebviewView.show).toHaveBeenCalledWith(true);
    });
  });

  describe('webview lifecycle', () => {
    it('should store pending message when webview is not resolved', () => {
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 3,
        executionTimeMs: 50,
      };

      // No resolveWebviewView called — webview is not available
      provider.show(result);

      // postMessage should NOT have been called (no webview)
      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    it('should handle dispose and re-resolve correctly', () => {
      // First resolve
      let disposeCallback: () => void = () => {};
      mockWebviewView.onDidDispose.mockImplementation((cb: () => void) => {
        disposeCallback = cb;
      });

      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      // Simulate webview disposal
      disposeCallback();

      // Now messages should be stored as pending
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 1,
        executionTimeMs: 10,
      };
      provider.show(result);

      // postMessage should not be called after dispose
      // (it was called 0 times for the pending message delivery during first resolve,
      //  but not for this new show() call)
      const callsAfterDispose = mockWebview.postMessage.mock.calls.filter(
        (call: any) => call[0].type === 'data' && call[0].result === result
      );
      expect(callsAfterDispose).toHaveLength(0);

      // Re-resolve delivers the pending message
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });
  });

  describe('dispose', () => {
    it('should clear the view reference', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      provider.dispose();

      // After dispose, messages should be stored as pending (no view)
      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 0,
        executionTimeMs: 0,
      };

      mockWebview.postMessage.mockClear();
      provider.show(result);

      // Should not post since view was disposed
      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('postMessage failure handling', () => {
    it('should store message as pending when postMessage throws', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      // Make postMessage throw (simulates webview disposed between check and call)
      mockWebview.postMessage.mockImplementation(() => {
        throw new Error('Webview is disposed');
      });

      const result: QueryResult = {
        resultSets: [
          {
            columns: [{ name: 'id', dataType: 'int' }],
            rows: [[1]],
            rowCount: 1,
          },
        ],
        rowsAffected: 0,
        executionTimeMs: 20,
      };

      // Should not throw — error is caught internally
      expect(() => provider.show(result)).not.toThrow();

      // Reset postMessage to work normally
      mockWebview.postMessage.mockResolvedValue(true);

      // Re-resolve should deliver the pending message
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });

    it('should clear view reference when postMessage throws', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      // Make postMessage throw
      mockWebview.postMessage.mockImplementation(() => {
        throw new Error('Webview is disposed');
      });

      provider.showProgress();

      // After the error, subsequent calls should also store as pending
      mockWebview.postMessage.mockClear();
      mockWebview.postMessage.mockImplementation(() => {
        throw new Error('Should not be called');
      });

      const result: QueryResult = {
        resultSets: [],
        rowsAffected: 1,
        executionTimeMs: 5,
      };

      // This should store as pending (view was cleared)
      provider.show(result);

      // postMessage should not have been called again (view is null)
      // The last pending message overwrites the progress one
      mockWebview.postMessage.mockResolvedValue(true);
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });
  });

  describe('onDidReceiveMessage handler', () => {
    it('should register a message handler on the webview', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.onDidReceiveMessage).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('should handle switchTab messages without throwing', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      // Get the registered message handler
      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0];

      // Should not throw when receiving a switchTab message
      expect(() =>
        messageHandler({ type: 'switchTab', tabIndex: 2 })
      ).not.toThrow();
    });

    it('should handle unknown message types gracefully', () => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0];

      // Should not throw for unknown message types
      expect(() =>
        messageHandler({ type: 'unknownType', data: 'test' })
      ).not.toThrow();
    });
  });

  describe('zero-row result set (Requirement 10.4)', () => {
    beforeEach(() => {
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );
    });

    it('should send data message for zero-row result set', () => {
      const result: QueryResult = {
        resultSets: [
          {
            columns: [
              { name: 'id', dataType: 'int' },
              { name: 'name', dataType: 'nvarchar' },
            ],
            rows: [],
            rowCount: 0,
          },
        ],
        rowsAffected: 0,
        executionTimeMs: 15,
      };

      provider.show(result);

      expect(mockWebview.postMessage).toHaveBeenCalledWith({
        type: 'data',
        result,
      });
    });

    it('should include execution time in zero-row result data', () => {
      const result: QueryResult = {
        resultSets: [
          {
            columns: [{ name: 'col1', dataType: 'varchar' }],
            rows: [],
            rowCount: 0,
          },
        ],
        rowsAffected: 0,
        executionTimeMs: 237,
      };

      provider.show(result);

      const postedMessage = mockWebview.postMessage.mock.calls.find(
        (call: any) => call[0].type === 'data'
      );
      expect(postedMessage).toBeDefined();
      expect(postedMessage![0].result.executionTimeMs).toBe(237);
    });

    it('should handle HTML rendering of zero-row message in webview content', () => {
      // The webview HTML contains the JavaScript that renders "No rows returned"
      // for zero-row result sets (Requirement 5.7). Verify the HTML includes this logic.
      provider.resolveWebviewView(
        mockWebviewView as any,
        {} as any,
        {} as any
      );

      expect(mockWebview.html).toContain('No rows returned');
      expect(mockWebview.html).toContain('executionTimeMs');
    });
  });
});
