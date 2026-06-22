import * as vscode from 'vscode';

/**
 * Represents a single reference match found in a workspace file.
 */
export interface ReferenceMatch {
  uri: vscode.Uri;
  range: vscode.Range;
  lineText: string;
}

/**
 * Options for finding references to a database object in the workspace.
 */
export interface FindReferencesOptions {
  objectName: string;
  objectType: 'table' | 'view' | 'column';
  schema?: string;
  parentObjectName?: string; // For columns: the table/view name
}

/**
 * Searches all .sql files in the workspace for references to database objects
 * (tables, views, columns). Handles schema-qualified, bracket-quoted, and
 * unqualified identifier forms. Filters out matches inside comments and strings.
 */
export class ReferenceFinder {
  /**
   * Search all .sql files in workspace for references to the given object.
   * Returns matches excluding those inside comments and string literals.
   */
  async findReferences(options: FindReferencesOptions): Promise<ReferenceMatch[]> {
    const { objectName, objectType, parentObjectName } = options;

    const files = await vscode.workspace.findFiles('**/*.sql');
    if (files.length === 0) {
      return [];
    }

    const pattern = this.buildSearchPattern(objectName);
    const matches: ReferenceMatch[] = [];

    for (const fileUri of files) {
      try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const text = document.getText();
        const lines = text.split(/\r?\n/);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const lineText = lines[lineIndex];
          let match: RegExpExecArray | null;

          // Reset regex lastIndex for each line since we use the 'g' flag
          pattern.lastIndex = 0;

          while ((match = pattern.exec(lineText)) !== null) {
            const matchStart = match.index;

            // Filter out matches inside comments or string literals
            if (this.isInsideCommentOrString(lineText, matchStart)) {
              continue;
            }

            const matchEnd = matchStart + match[0].length;
            const range = new vscode.Range(
              new vscode.Position(lineIndex, matchStart),
              new vscode.Position(lineIndex, matchEnd)
            );

            matches.push({
              uri: fileUri,
              range,
              lineText,
            });
          }
        }
      } catch {
        // Skip files that cannot be read (permissions, deleted, etc.)
        continue;
      }
    }

    // For column searches, filter to only files containing the parent table/view
    if (objectType === 'column' && parentObjectName) {
      return this.filterByParentObject(matches, parentObjectName);
    }

    return matches;
  }

  /**
   * Build a regex pattern for whole-word, case-insensitive matching of an object name.
   * Handles schema-qualified (dbo.Name, [dbo].[Name]) and unqualified forms.
   *
   * Matches:
   * - Unqualified: Name
   * - Schema-qualified: schema.Name
   * - Bracket-quoted: [Name]
   * - Schema bracket-quoted: [schema].[Name]
   *
   * Uses word boundaries on the leading edge to prevent matching substrings.
   * Does NOT match Name as a substring of a longer identifier.
   */
  buildSearchPattern(objectName: string): RegExp {
    // Escape special regex characters in the object name
    const escaped = objectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build pattern components:
    // 1. Optional schema prefix: either word.  or [word].
    const schemaPrefix = '(?:(?:\\w+|\\[\\w+\\])\\.)?';

    // 2. The object name itself: either bare Name or [Name]
    const namePattern = `(?:\\[${escaped}\\]|${escaped})`;

    // 3. Word boundary logic:
    //    - Leading: \b for bare name, or lookbehind for [ (bracket-quoted)
    //    - Trailing: \b for bare name, or ] handles the boundary naturally
    //
    // We use a combined approach:
    // - Match optional schema prefix + name
    // - Use word boundary at the start (before schema or name)
    // - Use a negative lookahead at the end to prevent matching longer identifiers

    // Full pattern: word boundary (or start after non-word char), optional schema, name, word boundary (or end before non-word char)
    const fullPattern = `(?<![\\w])${schemaPrefix}${namePattern}(?![\\w])`;

    return new RegExp(fullPattern, 'gi');
  }

  /**
   * Determine if a match position is inside a comment or string literal.
   * Scans from line start to match position tracking parser state.
   *
   * Handles:
   * - Single-line comments: -- (rest of line is comment)
   * - Block comments: opening with slash-star, closing with star-slash
   * - String literals: '...' (with '' as escape)
   */
  isInsideCommentOrString(lineText: string, matchStart: number): boolean {
    let inBlockComment = false;
    let inString = false;
    let inLineComment = false;

    for (let i = 0; i < matchStart; i++) {
      const ch = lineText[i];
      const next = i + 1 < lineText.length ? lineText[i + 1] : '';

      if (inLineComment) {
        // Once in a line comment, everything to end of line is comment
        return true;
      }

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++; // skip the '/'
        }
        continue;
      }

      if (inString) {
        if (ch === "'") {
          // Check for escaped quote ('')
          if (next === "'") {
            i++; // skip the escaped quote
          } else {
            inString = false;
          }
        }
        continue;
      }

      // Normal context
      if (ch === '-' && next === '-') {
        inLineComment = true;
        return true; // matchStart is after --, so it's in comment
      } else if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++; // skip the '*'
      } else if (ch === "'") {
        inString = true;
      }
    }

    // If we're still inside a block comment or string at matchStart, it's inside
    return inBlockComment || inString;
  }

  /**
   * For column searches: filter results to only files containing the parent table/view name.
   * Checks each unique file for a whole-word, case-insensitive occurrence of the parent name.
   */
  async filterByParentObject(
    matches: ReferenceMatch[],
    parentObjectName: string
  ): Promise<ReferenceMatch[]> {
    if (matches.length === 0) {
      return [];
    }

    // Build a whole-word pattern for the parent object name
    const escaped = parentObjectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parentPattern = new RegExp(`(?<![\\w])(?:\\[${escaped}\\]|${escaped})(?![\\w])`, 'i');

    // Get unique file URIs
    const fileUris = new Map<string, vscode.Uri>();
    for (const match of matches) {
      fileUris.set(match.uri.toString(), match.uri);
    }

    // Check which files contain the parent object name
    const filesWithParent = new Set<string>();

    for (const [uriString, uri] of fileUris) {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();

        if (parentPattern.test(text)) {
          filesWithParent.add(uriString);
        }
      } catch {
        // Skip files that cannot be read
        continue;
      }
    }

    // Filter matches to only those in files containing the parent object
    return matches.filter(match => filesWithParent.has(match.uri.toString()));
  }
}
