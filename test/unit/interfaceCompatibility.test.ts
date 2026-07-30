/**
 * Compile-time structural compatibility check for the encrypt and trustServerCertificate
 * fields across the two client-side interfaces.
 *
 * This file verifies that a config object with:
 *   encrypt: 'Optional' | 'Mandatory' | 'Strict' | undefined
 *   trustServerCertificate: boolean
 * is assignable to both ConnectionConfig (src/types.ts) and
 * ServerConnectionConfig (src/objectExplorer/types.ts).
 *
 * Note: The server's ConnectionConfig (server/src/server.ts) cannot be imported
 * from the client tsconfig. Its compatibility is verified separately via
 * `npm run compile` (which compiles both tsconfigs independently).
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */
import { describe, it, expect } from 'vitest';
import { ConnectionConfig } from '../../src/types';
import { ServerConnectionConfig } from '../../src/objectExplorer/types';

describe('Interface Structural Compatibility', () => {
  const encryptValues: Array<'Optional' | 'Mandatory' | 'Strict' | undefined> = [
    'Optional',
    'Mandatory',
    'Strict',
    undefined,
  ];

  const trustValues: boolean[] = [true, false];

  it('config objects with all encrypt values are assignable to ConnectionConfig', () => {
    for (const encrypt of encryptValues) {
      for (const trust of trustValues) {
        // This assignment is a compile-time check — if the types are incompatible,
        // TypeScript will produce a type error and `npm run compile` will fail.
        const config: ConnectionConfig = {
          name: 'Test Server',
          host: 'localhost',
          encrypt,
          trustServerCertificate: trust,
        };

        // Runtime verification that the object was constructed correctly
        expect(config.encrypt).toBe(encrypt);
        expect(config.trustServerCertificate).toBe(trust);
      }
    }
  });

  it('config objects with all encrypt values are assignable to ServerConnectionConfig', () => {
    for (const encrypt of encryptValues) {
      for (const trust of trustValues) {
        // This assignment is a compile-time check — if the types are incompatible,
        // TypeScript will produce a type error and `npm run compile` will fail.
        const config: ServerConnectionConfig = {
          name: 'Test Server',
          host: 'localhost',
          authType: 'sql',
          encrypt,
          trustServerCertificate: trust,
        };

        // Runtime verification that the object was constructed correctly
        expect(config.encrypt).toBe(encrypt);
        expect(config.trustServerCertificate).toBe(trust);
      }
    }
  });

  it('ConnectionConfig encrypt field accepts the full union type', () => {
    // Compile-time: verify the type annotation works
    const configs: ConnectionConfig[] = [
      { name: 'A', host: 'h1', encrypt: 'Optional', trustServerCertificate: true },
      { name: 'B', host: 'h2', encrypt: 'Mandatory', trustServerCertificate: false },
      { name: 'C', host: 'h3', encrypt: 'Strict', trustServerCertificate: false },
      { name: 'D', host: 'h4', trustServerCertificate: true }, // encrypt is undefined
    ];

    expect(configs).toHaveLength(4);
    expect(configs[0].encrypt).toBe('Optional');
    expect(configs[1].encrypt).toBe('Mandatory');
    expect(configs[2].encrypt).toBe('Strict');
    expect(configs[3].encrypt).toBeUndefined();
  });

  it('ServerConnectionConfig encrypt field accepts the full union type', () => {
    // Compile-time: verify the type annotation works
    const configs: ServerConnectionConfig[] = [
      { name: 'A', host: 'h1', authType: 'sql', encrypt: 'Optional', trustServerCertificate: true },
      { name: 'B', host: 'h2', authType: 'windows', encrypt: 'Mandatory', trustServerCertificate: false },
      { name: 'C', host: 'h3', authType: 'sql', encrypt: 'Strict', trustServerCertificate: false },
      { name: 'D', host: 'h4', authType: 'windows', trustServerCertificate: true }, // encrypt is undefined
    ];

    expect(configs).toHaveLength(4);
    expect(configs[0].encrypt).toBe('Optional');
    expect(configs[1].encrypt).toBe('Mandatory');
    expect(configs[2].encrypt).toBe('Strict');
    expect(configs[3].encrypt).toBeUndefined();
  });
});
