// Connection Persistence Helpers
// Pure functions for serializing, deserializing, filtering, and removing connections.
// No side effects or file I/O — designed for testability.

import { ServerConnectionConfig } from './types';

/**
 * Serializes a ServerConnectionConfig to a plain object suitable for JSON serialization.
 * Excludes the password field to ensure credentials are never persisted.
 */
export function serializeConnection(config: ServerConnectionConfig): object {
  const { password, ...rest } = config;
  return rest;
}

/**
 * Deserializes a JSON string into an array of valid ServerConnectionConfig entries.
 * Expected format: { "connections": [...] }
 * Returns an empty array for invalid JSON or missing "connections" array.
 */
export function deserializeConnections(json: string): ServerConnectionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).connections)
  ) {
    return [];
  }

  const entries = (parsed as { connections: unknown[] }).connections;
  return filterValidConnections(entries);
}

/**
 * Filters an array of unknown entries, returning only those that are valid
 * ServerConnectionConfig objects (must have required fields: name, host, authType).
 */
export function filterValidConnections(entries: unknown[]): ServerConnectionConfig[] {
  return entries.filter(isValidConnectionEntry) as ServerConnectionConfig[];
}

/**
 * Removes a connection from the list by name (exact match).
 * Returns a new array without the connection matching the given name.
 */
export function removeConnectionFromList(
  connections: ServerConnectionConfig[],
  name: string
): ServerConnectionConfig[] {
  return connections.filter(c => c.name !== name);
}

/**
 * Type guard that validates an entry has the required fields for a ServerConnectionConfig.
 * Required: name (non-empty string), host (non-empty string), authType ('sql' | 'windows').
 */
function isValidConnectionEntry(entry: unknown): entry is ServerConnectionConfig {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  // Required: name must be a non-empty string
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    return false;
  }

  // Required: host must be a non-empty string
  if (typeof obj.host !== 'string' || obj.host.trim() === '') {
    return false;
  }

  // Required: authType must be 'sql' or 'windows'
  if (obj.authType !== 'sql' && obj.authType !== 'windows') {
    return false;
  }

  // Optional field validation: port must be a number in valid range if present
  if (obj.port !== undefined && obj.port !== null) {
    if (typeof obj.port !== 'number' || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      return false;
    }
  }

  return true;
}
