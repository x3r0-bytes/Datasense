import * as vscode from 'vscode';
import { ReferenceMatch } from './referenceFinder';

/**
 * Result of a successful rename operation.
 */
export interface RenameResult {
  filesModified: number;
  replacementsCount: number;
}

/**
 * Handles workspace-wide rename refactoring for database objects.
 * Prompts the user for a new name, validates it, builds a WorkspaceEdit
 * with text replacements preserving schema qualifiers and bracket quoting,
 * and applies it with a refactor preview diff.
 */
export class RenameRefactorHandler {
  /**
   * Prompt user for new name, build WorkspaceEdit, apply with refactor preview.
   * Returns undefined if the user cancels or provides the same name.
   */
  async performRename(
    currentName: string,
    matches: ReferenceMatch[]
  ): Promise<RenameResult | undefined> {
    // 1. Show input box pre-filled with currentName
    const newName = await vscode.window.showInputBox({
      prompt: 'Enter the new name for this object',
      value: currentName,
      validateInput: (value: string) => this.validateNewName(value),
    });

    // 2. If user cancels (result undefined), return undefined
    if (newName === undefined) {
      return undefined;
    }

    // 3. If new name equals current name (case-insensitive), dismiss silently
    if (newName.toLowerCase() === currentName.toLowerCase()) {
      return undefined;
    }

    // 4. Build WorkspaceEdit with refactor metadata for confirmation
    const edit = this.buildWorkspaceEdit(matches, currentName, newName);

    // 5. Apply with refactoring preview (shows diff view for user to accept/reject)
    const success = await vscode.workspace.applyEdit(edit, {
      isRefactoring: true,
    });

    if (success) {
      // Count replacements and unique files
      const fileUris = new Set<string>();
      for (const match of matches) {
        fileUris.add(match.uri.toString());
      }
      const result: RenameResult = {
        filesModified: fileUris.size,
        replacementsCount: matches.length,
      };

      // Show summary notification
      vscode.window.showInformationMessage(
        `Renamed '${currentName}' to '${newName}': ${result.replacementsCount} replacement(s) across ${result.filesModified} file(s).`
      );

      return result;
    } else {
      // applyEdit returned false — some changes could not be applied
      vscode.window.showErrorMessage(
        'Some changes could not be applied. One or more files may be read-only.'
      );
      return undefined;
    }
  }

  /**
   * Validate the new name: non-empty, 1-128 chars, no whitespace, no . [ ] ' " characters.
   * Returns an error message string if invalid, or undefined if the name is valid.
   */
  validateNewName(name: string): string | undefined {
    if (!name || name.length === 0) {
      return 'Name cannot be empty';
    }

    if (name.length > 128) {
      return 'Name must be 128 characters or fewer';
    }

    if (/\s/.test(name)) {
      return 'Name cannot contain whitespace';
    }

    if (/[.\[\]'"]/.test(name)) {
      return 'Name cannot contain . [ ] \' or " characters';
    }

    return undefined;
  }

  /**
   * Build a WorkspaceEdit replacing all matched occurrences.
   * Preserves schema qualifiers and bracket quoting by using computeReplacement
   * for each match's text. Uses entry metadata with needsConfirmation for refactor preview.
   */
  buildWorkspaceEdit(
    matches: ReferenceMatch[],
    oldName: string,
    newName: string
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();

    const metadata: vscode.WorkspaceEditEntryMetadata = {
      needsConfirmation: true,
      label: `Rename '${oldName}' to '${newName}'`,
    };

    for (const match of matches) {
      // Extract the matched text from the line using the range
      const matchText = match.lineText.substring(
        match.range.start.character,
        match.range.end.character
      );

      const replacement = this.computeReplacement(matchText, oldName, newName);
      edit.replace(match.uri, match.range, replacement, metadata);
    }

    return edit;
  }

  /**
   * Compute the replacement text for a single match.
   * Handles the following forms (case-insensitive matching for old name):
   * - `[schema].[OldName]` → `[schema].[NewName]`
   * - `schema.OldName` → `schema.NewName`
   * - `[OldName]` → `[NewName]`
   * - `OldName` → `NewName`
   */
  computeReplacement(matchText: string, oldName: string, newName: string): string {
    const oldNameLower = oldName.toLowerCase();

    // Pattern: [schema].[OldName] — bracket-quoted schema + bracket-quoted name
    const bracketSchemaPattern = /^\[([^\]]+)\]\.\[([^\]]+)\]$/i;
    const bracketSchemaMatch = bracketSchemaPattern.exec(matchText);
    if (bracketSchemaMatch) {
      const schemaName = bracketSchemaMatch[1];
      const objectNamePart = bracketSchemaMatch[2];
      if (objectNamePart.toLowerCase() === oldNameLower) {
        return `[${schemaName}].[${newName}]`;
      }
    }

    // Pattern: schema.OldName — unquoted schema + unquoted name (no brackets)
    const schemaPattern = /^(\w+)\.(\w+)$/i;
    const schemaMatch = schemaPattern.exec(matchText);
    if (schemaMatch) {
      const schemaName = schemaMatch[1];
      const objectNamePart = schemaMatch[2];
      if (objectNamePart.toLowerCase() === oldNameLower) {
        return `${schemaName}.${newName}`;
      }
    }

    // Pattern: [OldName] — bracket-quoted name only (no schema)
    const bracketPattern = /^\[([^\]]+)\]$/i;
    const bracketMatch = bracketPattern.exec(matchText);
    if (bracketMatch) {
      const objectNamePart = bracketMatch[1];
      if (objectNamePart.toLowerCase() === oldNameLower) {
        return `[${newName}]`;
      }
    }

    // Pattern: OldName — plain unquoted name
    if (matchText.toLowerCase() === oldNameLower) {
      return newName;
    }

    // Fallback: return the match text with old name replaced (case-insensitive)
    const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return matchText.replace(new RegExp(escapedOld, 'i'), newName);
  }
}
