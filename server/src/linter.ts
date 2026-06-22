/**
 * T-SQL Linter — Converts parser syntax errors into LSP Diagnostics
 * AND runs semantic analysis rules for deeper error detection.
 * Invoked from server.ts on textDocument/didOpen and textDocument/didChange events.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { parseDocument, SyntaxError } from './tsqlParser';
import { semanticLint } from './semanticLinter';
import { lintObjectReferences, ObjectReferenceLinterContext } from './objectReferenceLinter';
import { lintEnhancedSyntax, EnhancedSyntaxLinterContext } from './enhancedSyntaxLinter';

/**
 * Configuration for the linter.
 */
export interface LinterConfig {
  enabled: boolean;
}

/**
 * Runtime context passed to lintDocument from server.ts.
 * Provides connection state and schema cache access for schema-dependent linting phases.
 */
export interface LinterContext {
  schemaCache: ObjectReferenceLinterContext['schemaCache'];
  isConnected: boolean;
  isRefreshing: boolean;
}

/**
 * Lint a document and return diagnostics.
 * Splits on GO boundaries, parses each batch independently.
 * Runs both syntax error detection AND semantic analysis rules.
 * Returns empty array if linting is disabled.
 *
 * @param text    - Full document text
 * @param config  - Linter configuration (enabled/disabled)
 * @param context - Optional runtime context; Phase 3 is skipped when absent or disconnected
 */
export function lintDocument(text: string, config: LinterConfig, context?: LinterContext): Diagnostic[] {
  if (!config.enabled) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];

  // Phase 1: Syntax errors from the parser
  const results = parseDocument(text);
  for (const result of results) {
    if (result.errors.length > 0) {
      // parseDocument already adjusts line numbers per batch,
      // so we pass batchStartLine = 0 here
      const batchDiagnostics = syntaxErrorsToDiagnostics(result.errors, 0);
      diagnostics.push(...batchDiagnostics);
    }
  }

  // Phase 2: Semantic analysis rules (operates on raw text, batch-aware)
  const batches = splitOnGoBoundaries(text);
  for (const batch of batches) {
    const semanticDiagnostics = semanticLint(batch.text, batch.startLine);
    diagnostics.push(...semanticDiagnostics);
  }

  // Phase 3: Object reference validation (schema-aware, skipped when disconnected/refreshing)
  // Skip entirely when: no context provided, not connected, or cache is refreshing.
  if (context && context.isConnected && !context.isRefreshing) {
    const objectRefContext: ObjectReferenceLinterContext = {
      schemaCache: context.schemaCache,
      isConnected: context.isConnected,
      isRefreshing: context.isRefreshing,
    };
    for (const batch of batches) {
      const objectRefDiagnostics = lintObjectReferences(batch.text, batch.startLine, objectRefContext);
      diagnostics.push(...objectRefDiagnostics);
    }
  }

  // Phase 4: Enhanced syntax error detection (always runs — syntax-only rules fire without a
  // connection; schema-dependent rules inside lintEnhancedSyntax are gated on isConnected).
  const enhancedContext: EnhancedSyntaxLinterContext = context
    ? { schemaCache: context.schemaCache, isConnected: context.isConnected }
    : { schemaCache: null, isConnected: false };
  for (const batch of batches) {
    const enhancedDiagnostics = lintEnhancedSyntax(batch.text, batch.startLine, enhancedContext);
    diagnostics.push(...enhancedDiagnostics);
  }

  return diagnostics;
}

/**
 * Split text on GO boundaries for semantic analysis.
 * GO is recognized case-insensitively on its own line.
 */
function splitOnGoBoundaries(text: string): Array<{ text: string; startLine: number }> {
  const lines = text.split('\n');
  const batches: Array<{ text: string; startLine: number }> = [];
  let batchLines: string[] = [];
  let batchStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^GO\s*$/i.test(trimmed)) {
      if (batchLines.length > 0) {
        batches.push({ text: batchLines.join('\n'), startLine: batchStartLine });
      }
      batchLines = [];
      batchStartLine = i + 1;
    } else {
      batchLines.push(lines[i]);
    }
  }

  if (batchLines.length > 0) {
    batches.push({ text: batchLines.join('\n'), startLine: batchStartLine });
  }

  return batches;
}

/**
 * Convert parser SyntaxErrors to LSP Diagnostics.
 * Adjusts line numbers by batchStartLine for multi-batch documents.
 */
export function syntaxErrorsToDiagnostics(
  errors: SyntaxError[],
  batchStartLine: number
): Diagnostic[] {
  return errors.map(error => {
    const startLine = error.range.start.line + batchStartLine;
    const endLine = error.range.end.line + batchStartLine;
    const startCol = error.range.start.column;
    const endCol = error.range.end.column;

    return {
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line: startLine, character: startCol },
        end: { line: endLine, character: endCol },
      },
      message: error.message,
      source: 'tsql',
    };
  });
}
