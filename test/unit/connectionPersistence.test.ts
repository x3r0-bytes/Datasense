import { describe, it, expect } from 'vitest';
import {
  serializeConnection,
  deserializeConnections,
  filterValidConnections,
  removeConnectionFromList,
} from '../../src/objectExplorer/connectionPersistence';
import { ServerConnectionConfig } from '../../src/objectExplorer/types';

describe('connectionPersistence', () => {
  describe('serializeConnection', () => {
    it('excludes the password field from the serialized output', () => {
      const config: ServerConnectionConfig = {
        name: 'Test Server',
        host: 'localhost',
        port: 1433,
        authType: 'sql',
        user: 'sa',
        password: 'secret123',
        encrypt: true,
        trustServerCertificate: false,
      };
      const result = serializeConnection(config) as Record<string, unknown>;
      expect(result).not.toHaveProperty('password');
    });

    it('preserves all non-password fields', () => {
      const config: ServerConnectionConfig = {
        name: 'My Server',
        host: 'db.example.com',
        port: 5000,
        database: 'mydb',
        authType: 'sql',
        user: 'admin',
        password: 'P@ss',
        encrypt: true,
        trustServerCertificate: true,
      };
      const result = serializeConnection(config) as Record<string, unknown>;
      expect(result).toEqual({
        name: 'My Server',
        host: 'db.example.com',
        port: 5000,
        database: 'mydb',
        authType: 'sql',
        user: 'admin',
        encrypt: true,
        trustServerCertificate: true,
      });
    });

    it('handles Windows auth config without user/password', () => {
      const config: ServerConnectionConfig = {
        name: 'Win Server',
        host: 'winhost',
        authType: 'windows',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = serializeConnection(config) as Record<string, unknown>;
      expect(result).toEqual({
        name: 'Win Server',
        host: 'winhost',
        authType: 'windows',
        encrypt: false,
        trustServerCertificate: true,
      });
    });
  });

  describe('deserializeConnections', () => {
    it('parses valid JSON with connections array', () => {
      const json = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'host1', authType: 'windows' },
          { name: 'Server2', host: 'host2', authType: 'sql', user: 'sa' },
        ],
      });
      const result = deserializeConnections(json);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Server1');
      expect(result[1].name).toBe('Server2');
    });

    it('returns empty array for invalid JSON', () => {
      const result = deserializeConnections('not valid json {{{');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      const result = deserializeConnections('');
      expect(result).toEqual([]);
    });

    it('returns empty array when JSON has no connections field', () => {
      const result = deserializeConnections(JSON.stringify({ servers: [] }));
      expect(result).toEqual([]);
    });

    it('returns empty array when connections is not an array', () => {
      const result = deserializeConnections(JSON.stringify({ connections: 'not-array' }));
      expect(result).toEqual([]);
    });

    it('filters out invalid entries from the connections array', () => {
      const json = JSON.stringify({
        connections: [
          { name: 'Valid', host: 'host1', authType: 'windows' },
          { name: '', host: 'host2', authType: 'sql' }, // invalid: empty name
          { host: 'host3', authType: 'windows' }, // invalid: missing name
          { name: 'Also Valid', host: 'host4', authType: 'sql' },
        ],
      });
      const result = deserializeConnections(json);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Valid');
      expect(result[1].name).toBe('Also Valid');
    });

    it('returns empty array for null JSON value', () => {
      const result = deserializeConnections('null');
      expect(result).toEqual([]);
    });
  });

  describe('filterValidConnections', () => {
    it('returns only entries with required fields (name, host, authType)', () => {
      const entries = [
        { name: 'Good', host: 'localhost', authType: 'sql' },
        { name: 'Bad', host: '' }, // missing authType, empty host
        { name: '', host: 'host', authType: 'windows' }, // empty name
        { name: 'Also Good', host: 'remotehost', authType: 'windows' },
      ];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Good');
      expect(result[1].name).toBe('Also Good');
    });

    it('rejects entries with invalid authType', () => {
      const entries = [
        { name: 'Server', host: 'host', authType: 'kerberos' },
      ];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(0);
    });

    it('rejects null and non-object entries', () => {
      const entries = [null, undefined, 42, 'string', true];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(0);
    });

    it('rejects entries with invalid port values', () => {
      const entries = [
        { name: 'Server', host: 'host', authType: 'sql', port: 0 },
        { name: 'Server2', host: 'host', authType: 'sql', port: 70000 },
        { name: 'Server3', host: 'host', authType: 'sql', port: 3.14 },
      ];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(0);
    });

    it('accepts entries with valid optional port', () => {
      const entries = [
        { name: 'Server', host: 'host', authType: 'sql', port: 1433 },
      ];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(1);
    });

    it('accepts entries without port field', () => {
      const entries = [
        { name: 'Server', host: 'host', authType: 'windows' },
      ];
      const result = filterValidConnections(entries);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty input', () => {
      const result = filterValidConnections([]);
      expect(result).toEqual([]);
    });
  });

  describe('removeConnectionFromList', () => {
    const connections: ServerConnectionConfig[] = [
      { name: 'Server1', host: 'host1', authType: 'windows' },
      { name: 'Server2', host: 'host2', authType: 'sql', user: 'sa' },
      { name: 'Server3', host: 'host3', authType: 'windows' },
    ];

    it('removes the connection matching the given name', () => {
      const result = removeConnectionFromList(connections, 'Server2');
      expect(result).toHaveLength(2);
      expect(result.find(c => c.name === 'Server2')).toBeUndefined();
    });

    it('preserves all other connections unchanged', () => {
      const result = removeConnectionFromList(connections, 'Server2');
      expect(result[0]).toEqual(connections[0]);
      expect(result[1]).toEqual(connections[2]);
    });

    it('returns the same list when name is not found', () => {
      const result = removeConnectionFromList(connections, 'NonExistent');
      expect(result).toHaveLength(3);
      expect(result).toEqual(connections);
    });

    it('returns empty array when removing from empty list', () => {
      const result = removeConnectionFromList([], 'Server1');
      expect(result).toEqual([]);
    });

    it('returns a new array (does not mutate original)', () => {
      const result = removeConnectionFromList(connections, 'Server1');
      expect(result).not.toBe(connections);
      expect(connections).toHaveLength(3); // original unchanged
    });
  });
});
