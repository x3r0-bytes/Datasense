import * as vscode from 'vscode';
import { ShortcutEntry } from './types';

/**
 * Returns a static list of all extension keyboard shortcuts,
 * grouped by category and marked as default or proposed.
 */
export function getShortcutEntries(): ShortcutEntry[] {
  return [
    // ─── Query Execution ──────────────────────────────────────────────
    {
      label: 'Run Query',
      keybinding: 'Ctrl+Shift+E',
      command: 'sqlServer.runQuery',
      category: 'Query Execution',
      isDefault: true,
    },
    {
      label: 'Cancel Query',
      keybinding: 'Ctrl+Shift+Q',
      command: 'sqlServer.cancelQuery',
      category: 'Query Execution',
      isDefault: true,
    },
    {
      label: 'Run Current Statement',
      keybinding: 'Ctrl+Enter',
      command: 'sqlServer.runCurrentStatement',
      category: 'Query Execution',
      isDefault: true,
    },

    // ─── Connection ───────────────────────────────────────────────────
    {
      label: 'Switch Connection',
      keybinding: 'Ctrl+Shift+C',
      command: 'sqlServer.switchConnection',
      category: 'Connection',
      isDefault: false,
    },
    {
      label: 'Switch Server',
      keybinding: 'Ctrl+Shift+S',
      command: 'sqlServer.switchServer',
      category: 'Connection',
      isDefault: false,
    },
    {
      label: 'Switch Database',
      keybinding: 'Ctrl+Shift+D',
      command: 'sqlServer.switchDatabase',
      category: 'Connection',
      isDefault: false,
    },
    {
      label: 'Disconnect',
      keybinding: 'Ctrl+Shift+X',
      command: 'sqlServer.disconnect',
      category: 'Connection',
      isDefault: false,
    },

    // ─── Navigation ───────────────────────────────────────────────────
    {
      label: 'Show Keyboard Shortcuts',
      keybinding: 'Ctrl+Shift+/',
      command: 'sqlServer.showKeyboardShortcuts',
      category: 'Navigation',
      isDefault: true,
    },
    {
      label: 'Go to Definition',
      keybinding: 'Ctrl+Shift+G',
      command: 'sqlServer.goToDefinition',
      category: 'Navigation',
      isDefault: false,
    },
    {
      label: 'Refresh Schema',
      keybinding: 'Ctrl+Shift+R',
      command: 'sqlServer.refreshSchema',
      category: 'Navigation',
      isDefault: false,
    },
  ];
}

/**
 * Registers the `sqlServer.showKeyboardShortcuts` command which opens
 * a QuickPick listing all extension shortcuts grouped by category.
 */
export function registerKeyboardShortcutCommand(context: vscode.ExtensionContext): vscode.Disposable {
  const disposable = vscode.commands.registerCommand('sqlServer.showKeyboardShortcuts', async () => {
    const entries = getShortcutEntries();

    // Build QuickPick items grouped by category
    const items: vscode.QuickPickItem[] = [];
    const categories: Array<'Query Execution' | 'Connection' | 'Navigation'> = [
      'Query Execution',
      'Connection',
      'Navigation',
    ];

    for (const category of categories) {
      const categoryEntries = entries.filter(e => e.category === category);
      if (categoryEntries.length === 0) {
        continue;
      }

      // Add category separator
      items.push({
        label: category,
        kind: vscode.QuickPickItemKind.Separator,
      });

      // Add entries for this category
      for (const entry of categoryEntries) {
        const description = entry.isDefault
          ? entry.keybinding
          : `${entry.keybinding} (requires user configuration)`;

        items.push({
          label: entry.label,
          description,
          detail: entry.category,
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a keyboard shortcut to execute',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected || selected.kind === vscode.QuickPickItemKind.Separator) {
      return;
    }

    // Find the matching entry
    const matchedEntry = entries.find(e => e.label === selected.label);
    if (!matchedEntry) {
      return;
    }

    // Commands that require an active SQL editor
    const sqlEditorCommands = new Set([
      'sqlServer.runQuery',
      'sqlServer.cancelQuery',
      'sqlServer.runCurrentStatement',
      'sqlServer.goToDefinition',
    ]);

    // Check if the command requires an active SQL editor
    if (sqlEditorCommands.has(matchedEntry.command)) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showInformationMessage(
          `The command "${matchedEntry.label}" requires an active SQL file.`
        );
        return;
      }
    }

    // Execute the associated command
    await vscode.commands.executeCommand(matchedEntry.command);
  });

  return disposable;
}
