import { describe, it, expect } from 'vitest';
import {
  validate,
  isPortValid,
  isDisplayNameUnique,
} from '../../src/objectExplorer/connectionFormValidator';
import { ConnectionFormInput } from '../../src/objectExplorer/types';

describe('connectionFormValidator', () => {
  describe('validate', () => {
    it('returns valid: true for a complete SQL auth form', () => {
      const input: ConnectionFormInput = {
        authType: 'sql',
        serverName: 'localhost',
        displayName: 'My Server',
        port: '1433',
        encrypt: true,
        trustServerCertificate: false,
        username: 'sa',
        password: 'P@ssw0rd',
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid: true for a complete Windows auth form (no username/password)', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid: false with error on serverName when serverName is missing', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: '',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'serverName')).toBe(true);
    });

    it('returns valid: false with error on displayName when displayName is missing', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: '',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'displayName')).toBe(true);
    });

    it('returns valid: false with error on username when SQL auth and username is missing', () => {
      const input: ConnectionFormInput = {
        authType: 'sql',
        serverName: 'localhost',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
        username: '',
        password: 'P@ssw0rd',
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'username')).toBe(true);
    });

    it('returns valid: false with error on password when SQL auth and password is missing', () => {
      const input: ConnectionFormInput = {
        authType: 'sql',
        serverName: 'localhost',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
        username: 'sa',
        password: '',
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'password')).toBe(true);
    });

    it('returns valid: true for Windows auth with missing username (not required)', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
        username: '',
        password: '',
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid: false when serverName is whitespace-only', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: '   ',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'serverName')).toBe(true);
    });

    it('returns valid: false when displayName exceeds 128 characters', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'A'.repeat(129),
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'displayName')).toBe(true);
    });

    it('returns valid: true when displayName is exactly 128 characters', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'A'.repeat(128),
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid: false with port error when port is invalid', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'My Server',
        port: '0',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'port')).toBe(true);
    });

    it('returns valid: true when port is empty string (treated as not provided)', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'My Server',
        port: '',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid: true when port is undefined (not provided)', () => {
      const input: ConnectionFormInput = {
        authType: 'windows',
        serverName: 'localhost',
        displayName: 'My Server',
        encrypt: false,
        trustServerCertificate: true,
      };
      const result = validate(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('isPortValid', () => {
    it('returns false for port 0 (below minimum)', () => {
      expect(isPortValid(0)).toBe(false);
    });

    it('returns true for port 1 (minimum valid)', () => {
      expect(isPortValid(1)).toBe(true);
    });

    it('returns true for port 65535 (maximum valid)', () => {
      expect(isPortValid(65535)).toBe(true);
    });

    it('returns false for port 65536 (above maximum)', () => {
      expect(isPortValid(65536)).toBe(false);
    });

    it('returns true for string "1433"', () => {
      expect(isPortValid('1433')).toBe(true);
    });

    it('returns false for string "abc"', () => {
      expect(isPortValid('abc')).toBe(false);
    });

    it('returns false for string "3.14" (non-integer)', () => {
      expect(isPortValid('3.14')).toBe(false);
    });

    it('returns true for undefined (port is optional)', () => {
      expect(isPortValid(undefined)).toBe(true);
    });

    it('returns false for negative port number', () => {
      expect(isPortValid(-1)).toBe(false);
    });

    it('returns false for floating point number', () => {
      expect(isPortValid(3.14)).toBe(false);
    });
  });

  describe('isDisplayNameUnique', () => {
    it('returns false when name matches an existing name (same case)', () => {
      expect(isDisplayNameUnique('Server1', ['Server1', 'Server2'])).toBe(false);
    });

    it('returns false when name matches an existing name (different case)', () => {
      expect(isDisplayNameUnique('server1', ['Server1', 'Server2'])).toBe(false);
    });

    it('returns true when name is not in the existing list', () => {
      expect(isDisplayNameUnique('Server3', ['Server1', 'Server2'])).toBe(true);
    });

    it('returns true when existing list is empty', () => {
      expect(isDisplayNameUnique('AnyName', [])).toBe(true);
    });

    it('returns false for case-insensitive match with uppercase', () => {
      expect(isDisplayNameUnique('SERVER1', ['server1'])).toBe(false);
    });
  });
});
