import { describe, it, expect, vi } from 'vitest';

// Mock vscode module (required because connectionFormPanel.ts imports vscode)
vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
  },
  ViewColumn: { One: 1 },
  Uri: { file: vi.fn() },
  ThemeIcon: class {},
}));

import {
  validateConnectionFormData,
  ConnectionFormData,
} from '../../src/connectionFormPanel';

/**
 * Unit tests for ConnectionFormPanel validation logic.
 * Tests the exported `validateConnectionFormData` function which encapsulates
 * the form validation rules for Add and Edit connection modes.
 *
 * Requirements: 4.3, 4.5
 */

function validFormData(overrides?: Partial<ConnectionFormData>): ConnectionFormData {
  return {
    connectionName: 'My Server',
    server: 'localhost',
    port: 1433,
    database: 'master',
    authType: 'sql',
    username: 'sa',
    password: 'P@ssw0rd',
    color: '',
    trustServerCertificate: false,
    encrypt: 'Optional',
    ...overrides,
  };
}

describe('ConnectionFormPanel validation', () => {
  describe('server field', () => {
    it('rejects empty server name', () => {
      const data = validFormData({ server: '' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.server).toBeDefined();
      expect(errors.server).toContain('required');
    });

    it('rejects whitespace-only server name', () => {
      const data = validFormData({ server: '   ' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.server).toBeDefined();
    });
  });

  describe('port field', () => {
    it('rejects port 0 (below minimum)', () => {
      const data = validFormData({ port: 0 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeDefined();
      expect(errors.port).toContain('1 and 65535');
    });

    it('rejects port 65536 (above maximum)', () => {
      const data = validFormData({ port: 65536 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeDefined();
    });

    it('rejects negative port', () => {
      const data = validFormData({ port: -1 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeDefined();
    });

    it('rejects non-integer port', () => {
      const data = validFormData({ port: 3.14 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeDefined();
    });

    it('accepts port 1 (minimum valid)', () => {
      const data = validFormData({ port: 1 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeUndefined();
    });

    it('accepts port 65535 (maximum valid)', () => {
      const data = validFormData({ port: 65535 });
      const errors = validateConnectionFormData(data, []);
      expect(errors.port).toBeUndefined();
    });
  });

  describe('connectionName field', () => {
    it('rejects empty connection name', () => {
      const data = validFormData({ connectionName: '' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.connectionName).toBeDefined();
      expect(errors.connectionName).toContain('required');
    });

    it('rejects whitespace-only connection name', () => {
      const data = validFormData({ connectionName: '   ' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.connectionName).toBeDefined();
    });

    it('rejects duplicate connection name (case-insensitive)', () => {
      const data = validFormData({ connectionName: 'Production' });
      const existingNames = ['production', 'Development'];
      const errors = validateConnectionFormData(data, existingNames);
      expect(errors.connectionName).toBeDefined();
      expect(errors.connectionName).toContain('already exists');
    });

    it('rejects duplicate connection name with different casing', () => {
      const data = validFormData({ connectionName: 'MY SERVER' });
      const existingNames = ['My Server', 'Other'];
      const errors = validateConnectionFormData(data, existingNames);
      expect(errors.connectionName).toBeDefined();
    });

    it('accepts unique connection name', () => {
      const data = validFormData({ connectionName: 'New Server' });
      const existingNames = ['Production', 'Development'];
      const errors = validateConnectionFormData(data, existingNames);
      expect(errors.connectionName).toBeUndefined();
    });
  });

  describe('username field (SQL Auth)', () => {
    it('rejects empty username when SQL Auth selected', () => {
      const data = validFormData({ authType: 'sql', username: '' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.username).toBeDefined();
      expect(errors.username).toContain('required');
    });

    it('rejects whitespace-only username when SQL Auth selected', () => {
      const data = validFormData({ authType: 'sql', username: '   ' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.username).toBeDefined();
    });

    it('does not require username when Windows Auth selected', () => {
      const data = validFormData({ authType: 'windows', username: '' });
      const errors = validateConnectionFormData(data, []);
      expect(errors.username).toBeUndefined();
    });
  });

  describe('valid form data in Add mode', () => {
    it('accepts valid form data with no existing connections', () => {
      const data = validFormData();
      const errors = validateConnectionFormData(data, []);
      expect(Object.keys(errors)).toHaveLength(0);
    });

    it('accepts valid form data with unique name among existing connections', () => {
      const data = validFormData({ connectionName: 'New Connection' });
      const existingNames = ['Production', 'Development'];
      const errors = validateConnectionFormData(data, existingNames);
      expect(Object.keys(errors)).toHaveLength(0);
    });

    it('accepts valid Windows Auth form data (no username required)', () => {
      const data = validFormData({
        authType: 'windows',
        username: '',
        password: '',
      });
      const errors = validateConnectionFormData(data, []);
      expect(Object.keys(errors)).toHaveLength(0);
    });
  });

  describe('valid form data in Edit mode (password optional)', () => {
    it('accepts valid form data with empty password in Edit mode', () => {
      const data = validFormData({ password: '' });
      const errors = validateConnectionFormData(data, [], 'My Server');
      expect(Object.keys(errors)).toHaveLength(0);
    });

    it('allows keeping the same connection name in Edit mode', () => {
      const data = validFormData({ connectionName: 'My Server' });
      const existingNames = ['My Server', 'Other Server'];
      // In edit mode, the current name is excluded from uniqueness check
      const errors = validateConnectionFormData(data, existingNames, 'My Server');
      expect(errors.connectionName).toBeUndefined();
    });

    it('rejects duplicate name against other connections in Edit mode', () => {
      const data = validFormData({ connectionName: 'Other Server' });
      const existingNames = ['My Server', 'Other Server'];
      // Editing "My Server" but trying to rename to "Other Server" which already exists
      const errors = validateConnectionFormData(data, existingNames, 'My Server');
      expect(errors.connectionName).toBeDefined();
      expect(errors.connectionName).toContain('already exists');
    });

    it('allows case-insensitive match of own name in Edit mode', () => {
      const data = validFormData({ connectionName: 'my server' });
      const existingNames = ['My Server', 'Other Server'];
      // Editing "My Server" and just changing case — should be allowed
      const errors = validateConnectionFormData(data, existingNames, 'My Server');
      expect(errors.connectionName).toBeUndefined();
    });
  });
});
