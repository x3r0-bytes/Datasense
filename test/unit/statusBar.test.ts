import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConnectionConfig } from '../../src/types';

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

describe('StatusBar', () => {
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

  describe('initialization', () => {
    it('should display "No SQL Connection" on creation', () => {
      expect(mockStatusBarItem.text).toBe('$(database) No SQL Connection');
    });

    it('should register switchConnection command', () => {
      expect(mockStatusBarItem.command).toBe('sqlServer.switchConnection');
    });

    it('should show the status bar item', () => {
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should display "{name} ({database})" when connected', () => {
      const config: ConnectionConfig = {
        name: 'Local Dev',
        host: 'localhost',
        database: 'MyDatabase',
      };

      statusBar.update(config);

      expect(mockStatusBarItem.text).toBe('$(database) Local Dev (MyDatabase)');
    });

    it('should display "No SQL Connection" when disconnected', () => {
      statusBar.update(null);

      expect(mockStatusBarItem.text).toBe('$(database) No SQL Connection');
    });

    it('should include host and port in tooltip when connected', () => {
      const config: ConnectionConfig = {
        name: 'Production',
        host: 'prod-server',
        port: 5432,
        database: 'ProdDB',
      };

      statusBar.update(config);

      expect(mockStatusBarItem.tooltip).toBe(
        'Connected to Production - prod-server:5432/ProdDB'
      );
    });

    it('should default port to 1433 in tooltip when not specified', () => {
      const config: ConnectionConfig = {
        name: 'Local',
        host: 'localhost',
        database: 'TestDB',
      };

      statusBar.update(config);

      expect(mockStatusBarItem.tooltip).toBe(
        'Connected to Local - localhost:1433/TestDB'
      );
    });

    it('should clear warning background when updating connection', () => {
      statusBar.showWarning('Some warning');
      const config: ConnectionConfig = {
        name: 'Dev',
        host: 'localhost',
        database: 'DevDB',
      };

      statusBar.update(config);

      expect(mockStatusBarItem.backgroundColor).toBeUndefined();
    });
  });

  describe('showWarning', () => {
    it('should prepend warning icon to status bar text', () => {
      const config: ConnectionConfig = {
        name: 'Dev',
        host: 'localhost',
        database: 'DevDB',
      };
      statusBar.update(config);

      statusBar.showWarning('Schema cache cannot connect');

      expect(mockStatusBarItem.text).toContain('$(warning)');
    });

    it('should set warning background color', () => {
      statusBar.showWarning('Connection issue');

      expect(mockStatusBarItem.backgroundColor).toBeDefined();
      expect(mockStatusBarItem.backgroundColor.id).toBe(
        'statusBarItem.warningBackground'
      );
    });

    it('should set tooltip to warning message', () => {
      statusBar.showWarning('Schema cache cannot connect');

      expect(mockStatusBarItem.tooltip).toBe('Schema cache cannot connect');
    });

    it('should not duplicate warning icon on multiple calls', () => {
      statusBar.showWarning('First warning');
      statusBar.showWarning('Second warning');

      const warningCount = (
        mockStatusBarItem.text.match(/\$\(warning\)/g) || []
      ).length;
      expect(warningCount).toBe(1);
    });
  });

  describe('dispose', () => {
    it('should dispose the status bar item', () => {
      statusBar.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
