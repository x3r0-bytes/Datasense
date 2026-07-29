/**
 * Connection Diagnostics
 * Provides a command that dumps Windows Auth driver detection status
 * to the Output panel for remote debugging.
 */

import * as vscode from 'vscode';

/**
 * Runs connection diagnostics and writes results to the given output channel.
 * Checks: msnodesqlv8 loadability, ODBC driver registry detection, and platform info.
 */
export function runConnectionDiagnostics(outputChannel: vscode.OutputChannel): void {
  outputChannel.show(true);
  outputChannel.appendLine('');
  outputChannel.appendLine('=== Datasense Connection Diagnostics ===');
  outputChannel.appendLine(`Timestamp: ${new Date().toISOString()}`);
  outputChannel.appendLine(`Platform: ${process.platform} (${process.arch})`);
  outputChannel.appendLine(`Node.js: ${process.version}`);
  outputChannel.appendLine(`Electron: ${process.versions.electron || 'N/A'}`);
  outputChannel.appendLine('');

  // 1. Check msnodesqlv8 native module
  outputChannel.appendLine('--- msnodesqlv8 Native Module ---');
  try {
    require('mssql/msnodesqlv8');
    outputChannel.appendLine('✓ msnodesqlv8 loaded successfully');
  } catch (err: any) {
    outputChannel.appendLine('✗ msnodesqlv8 FAILED to load');
    outputChannel.appendLine(`  Error: ${err?.message || String(err)}`);
    outputChannel.appendLine('  This means Windows Authentication will not work.');
    outputChannel.appendLine('  Cause: Usually a Node.js/Electron ABI version mismatch.');
  }
  outputChannel.appendLine('');

  // 2. Check ODBC Driver registry
  outputChannel.appendLine('--- ODBC Driver Detection ---');
  if (process.platform !== 'win32') {
    outputChannel.appendLine('⚠ Not running on Windows — ODBC Driver detection is Windows-only.');
  } else {
    const { execSync } = require('child_process');

    // Check both 64-bit and 32-bit registry hives
    const registryPaths = [
      { label: '64-bit registry', path: 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI' },
      { label: '32-bit registry (WOW6432Node)', path: 'HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBCINST.INI' },
    ];

    for (const reg of registryPaths) {
      outputChannel.appendLine(`  Checking ${reg.label}:`);
      try {
        const output = execSync(
          `reg query "${reg.path}" /s /f "ODBC Driver" /k`,
          { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' }
        ) as string;

        const driverPattern = /ODBC Driver (\d+) for SQL Server/g;
        let match: RegExpExecArray | null;
        const found: string[] = [];

        while ((match = driverPattern.exec(output)) !== null) {
          found.push(`ODBC Driver ${match[1]} for SQL Server`);
        }

        if (found.length > 0) {
          for (const d of found) {
            outputChannel.appendLine(`    ✓ ${d}`);
          }
        } else {
          outputChannel.appendLine('    ✗ No ODBC Driver for SQL Server found');
        }
      } catch {
        outputChannel.appendLine('    ✗ Registry query failed (path may not exist)');
      }
    }

    // Show which driver would be selected
    outputChannel.appendLine('');
    outputChannel.appendLine('  Selected driver:');
    try {
      const output = execSync(
        'reg query "HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI" /s /f "ODBC Driver" /k',
        { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' }
      ) as string;

      const driverPattern = /ODBC Driver (\d+) for SQL Server/g;
      let match: RegExpExecArray | null;
      let highestVersion = 0;

      while ((match = driverPattern.exec(output)) !== null) {
        const version = parseInt(match[1], 10);
        if (version >= 16 && version > highestVersion) {
          highestVersion = version;
        }
      }

      if (highestVersion > 0) {
        outputChannel.appendLine(`    → ODBC Driver ${highestVersion} for SQL Server`);
      } else {
        outputChannel.appendLine('    → None (no driver v16+ found in 64-bit registry)');
      }
    } catch {
      outputChannel.appendLine('    → Detection failed');
    }
  }

  outputChannel.appendLine('');
  outputChannel.appendLine('=== End Diagnostics ===');
  outputChannel.appendLine('');
}
