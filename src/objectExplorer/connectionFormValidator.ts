import { ConnectionFormInput, ValidationResult, ValidationError } from './types';

/**
 * Pure functions for validating connection form input.
 * Extracted from UI logic for testability.
 */

/**
 * Validates a connection form input and returns a ValidationResult.
 * Checks required fields: serverName, displayName, and (for SQL auth) username/password.
 * Also validates port if provided and display name length.
 */
export function validate(input: ConnectionFormInput): ValidationResult {
  const errors: ValidationError[] = [];

  // Server name: required, non-empty after trimming
  if (!input.serverName || input.serverName.trim().length === 0) {
    errors.push({ field: 'serverName', message: 'Server name is required' });
  }

  // Display name: required, non-empty after trimming, max 128 chars
  if (!input.displayName || input.displayName.trim().length === 0) {
    errors.push({ field: 'displayName', message: 'Display name is required' });
  } else if (input.displayName.trim().length > 128) {
    errors.push({ field: 'displayName', message: 'Display name must be 128 characters or fewer' });
  }

  // For SQL auth: username and password are required
  if (input.authType === 'sql') {
    if (!input.username || input.username.trim().length === 0) {
      errors.push({ field: 'username', message: 'Username is required for SQL Server Authentication' });
    }
    if (!input.password || input.password.trim().length === 0) {
      errors.push({ field: 'password', message: 'Password is required for SQL Server Authentication' });
    }
  }

  // Port: if provided, must be valid
  if (input.port !== undefined && input.port !== '') {
    if (!isPortValid(input.port)) {
      errors.push({ field: 'port', message: 'Port must be an integer between 1 and 65535' });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Checks whether a port value is a valid integer in the range [1, 65535].
 * Accepts numbers or numeric strings. Returns true for undefined (port is optional).
 */
export function isPortValid(port: string | number | undefined): boolean {
  if (port === undefined) {
    return true;
  }

  // Convert to number
  let numericPort: number;
  if (typeof port === 'number') {
    numericPort = port;
  } else {
    // Must be a string that represents a valid integer
    if (typeof port !== 'string' || port.trim().length === 0) {
      return false;
    }
    numericPort = Number(port);
  }

  // Must be a finite integer in [1, 65535]
  if (!Number.isFinite(numericPort) || !Number.isInteger(numericPort)) {
    return false;
  }

  return numericPort >= 1 && numericPort <= 65535;
}

/**
 * Checks whether a display name is unique among existing connection names.
 * Comparison is case-insensitive.
 */
export function isDisplayNameUnique(name: string, existing: string[]): boolean {
  const lowerName = name.toLowerCase();
  return !existing.some((existingName) => existingName.toLowerCase() === lowerName);
}
