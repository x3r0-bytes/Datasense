import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { ObjectExplorerConnectionManager } from '../../src/objectExplorer/objectExplorerConnectionManager';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('mssql', () => ({
  ConnectionPool: vi.fn(),
}));

vi.mock('mssql/msnodesqlv8', () => ({
  ConnectionPool: vi.fn(),
}));

import * as fs from 'fs';

describe('ObjectExplorerConnectionManager', () => {
  let manager: ObjectExplorerConnectionManager;
  const workspaceRoot = '/workspace';
  const expectedFilePath = path.join(workspaceRoot, '.sql-connections.json');

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ObjectExplorerConnectionManager(workspaceRoot);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('loadConnections', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = manager.loadConnections();

      expect(result).toEqual([]);
      expect(fs.existsSync).toHaveBeenCalledWith(expectedFilePath);
    });

    it('returns valid connections from a properly formatted file', () => {
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'localhost', authType: 'windows' },
          { name: 'Server2', host: 'remotehost', port: 1434, authType: 'sql', user: 'sa' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = manager.loadConnections();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Server1');
      expect(result[0].host).toBe('localhost');
      expect(result[0].authType).toBe('windows');
      expect(result[1].name).toBe('Server2');
      expect(result[1].host).toBe('remotehost');
      expect(result[1].port).toBe(1434);
      expect(result[1].authType).toBe('sql');
      expect(result[1].user).toBe('sa');
    });

    it('returns empty array for malformed JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

      const result = manager.loadConnections();

      expect(result).toEqual([]);
    });

    it('skips invalid entries and returns only valid ones', () => {
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Valid', host: 'host1', authType: 'windows' },
          { name: '', host: 'host2', authType: 'sql' },       // invalid: empty name
          { host: 'host3', authType: 'windows' },              // invalid: missing name
          { name: 'NoHost', authType: 'sql' },                 // invalid: missing host
          { name: 'BadAuth', host: 'host4', authType: 'kerberos' }, // invalid: bad authType
          { name: 'Also Valid', host: 'host5', authType: 'sql' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = manager.loadConnections();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Valid');
      expect(result[1].name).toBe('Also Valid');
    });
  });

  describe('saveConnection', () => {
    it('writes to file with password excluded', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await manager.saveConnection({
        name: 'TestServer',
        host: 'localhost',
        port: 1433,
        authType: 'sql',
        user: 'sa',
        password: 'secret123',
        encrypt: true,
        trustServerCertificate: false,
      });

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      expect(parsed.connections).toHaveLength(1);
      expect(parsed.connections[0]).not.toHaveProperty('password');
      expect(parsed.connections[0].name).toBe('TestServer');
      expect(parsed.connections[0].host).toBe('localhost');
      expect(parsed.connections[0].authType).toBe('sql');
      expect(parsed.connections[0].user).toBe('sa');
    });

    it('creates file if it does not exist (no error on first write)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      await manager.saveConnection({
        name: 'NewServer',
        host: 'newhost',
        authType: 'windows',
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        expect.any(String),
        'utf-8'
      );
    });
  });

  describe('removeConnection', () => {
    it('removes the connection from the file', async () => {
      // Load initial connections
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'host1', authType: 'windows' },
          { name: 'Server2', host: 'host2', authType: 'sql' },
          { name: 'Server3', host: 'host3', authType: 'windows' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      manager.loadConnections();

      await manager.removeConnection('Server2');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      expect(parsed.connections).toHaveLength(2);
      expect(parsed.connections.find((c: any) => c.name === 'Server2')).toBeUndefined();
      expect(parsed.connections[0].name).toBe('Server1');
      expect(parsed.connections[1].name).toBe('Server3');
    });

    it('handles non-existent connection gracefully', async () => {
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'host1', authType: 'windows' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      manager.loadConnections();

      // Should not throw
      await manager.removeConnection('NonExistent');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed.connections).toHaveLength(1);
      expect(parsed.connections[0].name).toBe('Server1');
    });
  });

  describe('password exclusion', () => {
    it('password is never present in the written file content', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await manager.saveConnection({
        name: 'SqlServer',
        host: 'dbhost',
        authType: 'sql',
        user: 'admin',
        password: 'SuperSecret!@#$',
        encrypt: true,
        trustServerCertificate: true,
      });

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;

      // The password string should not appear anywhere in the file
      expect(writtenContent).not.toContain('SuperSecret!@#$');
      expect(writtenContent).not.toContain('"password"');
    });
  });

  describe('getConnections', () => {
    it('returns the in-memory list after loading', () => {
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'host1', authType: 'windows' },
          { name: 'Server2', host: 'host2', authType: 'sql', user: 'sa' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      manager.loadConnections();

      const connections = manager.getConnections();

      expect(connections).toHaveLength(2);
      expect(connections[0].name).toBe('Server1');
      expect(connections[1].name).toBe('Server2');
    });

    it('returns a copy (not the internal array)', () => {
      const fileContent = JSON.stringify({
        connections: [
          { name: 'Server1', host: 'host1', authType: 'windows' },
        ],
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      manager.loadConnections();

      const connections1 = manager.getConnections();
      const connections2 = manager.getConnections();

      expect(connections1).not.toBe(connections2);
      expect(connections1).toEqual(connections2);
    });
  });
});
