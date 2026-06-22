import * as vscode from 'vscode';
import { splitBatchesWithLineInfo } from './batchSplitter';

/**
 * Extended CodeLens that carries batch metadata for resolution.
 */
interface BatchCodeLens extends vscode.CodeLens {
  batchNumber: number;
  totalBatches: number;
  document: vscode.TextDocument;
}

/**
 * Represents parsed batch information for navigation purposes.
 */
export interface BatchInfo {
  /** 1-based index among non-empty batches */
  batchNumber: number;
  /** 0-based line number of the first line in this batch (including blank lines) */
  startLine: number;
  /** 0-based line number of the last line in this batch */
  endLine: number;
  /** 0-based line number of the first non-blank line */
  firstNonBlankLine: number;
  /** Text of the first non-blank, non-comment line (trimmed, max 80 chars) */
  firstMeaningfulLine: string;
  /** Full text preview: first 60 chars of first non-blank line */
  preview: string;
}

/**
 * Provides CodeLens annotations and Document Symbols for GO-separated batches
 * in SQL files. Enables quick navigation between batches via inline labels,
 * breadcrumbs, and the Outline panel.
 */
export class BatchNavigatorProvider
  implements vscode.CodeLensProvider, vscode.DocumentSymbolProvider
{
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private _documentChangeSubscription: vscode.Disposable;

  constructor() {
    this._documentChangeSubscription = vscode.workspace.onDidChangeTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  /**
   * Parse a document into BatchInfo[]. Returns empty array for single-batch files
   * (no GO separators found). Reuses batchSplitter logic for GO detection with
   * comment/string awareness.
   */
  parseBatches(document: vscode.TextDocument): BatchInfo[] {
    const text = document.getText();
    const regions = splitBatchesWithLineInfo(text);

    // If there's only one region (or zero), no GO separators were found — return empty
    // splitBatchesWithLineInfo returns non-empty batches, but a single batch means
    // no GO separator was encountered, so we return empty for navigation purposes
    if (regions.length <= 1) {
      return [];
    }

    const batches: BatchInfo[] = [];
    let batchNumber = 1;

    for (const region of regions) {
      const lines = region.text.split('\n');
      const batchStartLine = region.startLine;

      // Find first non-blank line
      let firstNonBlankLine = -1;
      let firstNonBlankText = '';
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().length > 0) {
          firstNonBlankLine = batchStartLine + i;
          firstNonBlankText = lines[i].trim();
          break;
        }
      }

      // Skip if all-whitespace (shouldn't happen since splitBatchesWithLineInfo
      // already filters, but defensive)
      if (firstNonBlankLine === -1) {
        continue;
      }

      // Find first meaningful line (non-blank AND non-comment)
      const firstMeaningfulLine = findFirstMeaningfulLine(lines);

      // Build preview: first 60 chars of first non-blank line, truncated with "…"
      const preview = firstNonBlankText.length > 60
        ? firstNonBlankText.substring(0, 60) + '…'
        : firstNonBlankText;

      batches.push({
        batchNumber,
        startLine: region.startLine,
        endLine: region.endLine,
        firstNonBlankLine,
        firstMeaningfulLine,
        preview,
      });

      batchNumber++;
    }

    return batches;
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    // Check if batch navigator is disabled via settings
    const showBatchNavigator = vscode.workspace
      .getConfiguration('sqlServer.editor')
      .get('showBatchNavigator', true);

    if (!showBatchNavigator) {
      return [];
    }

    const batches = this.parseBatches(document);

    // No batches means single-batch file (no GO separators) — no CodeLens
    if (batches.length === 0) {
      return [];
    }

    const totalBatches = batches.length;

    return batches.map((batch) => {
      const range = new vscode.Range(
        batch.firstNonBlankLine, 0,
        batch.firstNonBlankLine, 0
      );

      const codeLens = new vscode.CodeLens(range) as BatchCodeLens;
      codeLens.batchNumber = batch.batchNumber;
      codeLens.totalBatches = totalBatches;
      codeLens.document = document;

      return codeLens;
    });
  }

  resolveCodeLens(
    codeLens: vscode.CodeLens,
    _token: vscode.CancellationToken
  ): vscode.CodeLens {
    const batchLens = codeLens as BatchCodeLens;

    codeLens.command = {
      command: 'sqlServer.batchNavigator.showQuickPick',
      title: `Batch ${batchLens.batchNumber} of ${batchLens.totalBatches}`,
      arguments: [batchLens.document],
    };

    return codeLens;
  }

  provideDocumentSymbols(
    _document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentSymbol[] {
    // Implemented in task 2.4
    return [];
  }

  async showBatchQuickPick(_document: vscode.TextDocument): Promise<void> {
    // Implemented in task 2.3
  }

  dispose(): void {
    this._documentChangeSubscription.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}

/**
 * Find the first line that is not blank AND not a SQL comment (-- or block comment).
 * Returns trimmed text, max 80 chars with "…" appended if truncated.
 * Returns empty string if the batch contains only blank/comment lines.
 */
function findFirstMeaningfulLine(lines: string[]): string {
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip blank lines
    if (trimmed.length === 0) {
      continue;
    }

    // Handle block comment state
    if (inBlockComment) {
      // Check if block comment ends on this line
      const endIdx = trimmed.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        // Check if there's meaningful content after the block comment end
        const afterComment = trimmed.substring(endIdx + 2).trim();
        if (afterComment.length > 0 && !afterComment.startsWith('--')) {
          return truncateTo80(afterComment);
        }
      }
      continue;
    }

    // Check for block comment start
    if (trimmed.startsWith('/*')) {
      // Check if block comment ends on same line
      const endIdx = trimmed.indexOf('*/', 2);
      if (endIdx !== -1) {
        // Block comment is self-contained on this line
        const afterComment = trimmed.substring(endIdx + 2).trim();
        if (afterComment.length > 0 && !afterComment.startsWith('--')) {
          return truncateTo80(afterComment);
        }
        // Otherwise the line is just a comment, continue
      } else {
        inBlockComment = true;
      }
      continue;
    }

    // Check for single-line comment
    if (trimmed.startsWith('--')) {
      continue;
    }

    // This line is meaningful (non-blank, non-comment)
    return truncateTo80(trimmed);
  }

  return '';
}

/**
 * Truncate a string to 80 characters, appending "…" if truncated.
 */
function truncateTo80(text: string): string {
  if (text.length > 80) {
    return text.substring(0, 80) + '…';
  }
  return text;
}
