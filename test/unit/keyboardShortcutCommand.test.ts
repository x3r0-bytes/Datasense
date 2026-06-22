import { describe, it, expect, vi } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  window: {
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
}));

import { getShortcutEntries } from '../../src/keyboardShortcutCommand';
import { ShortcutEntry } from '../../src/types';

describe('KeyboardShortcutCommand', () => {
  describe('getShortcutEntries', () => {
    let entries: ShortcutEntry[];

    entries = getShortcutEntries();

    it('returns entries for all three categories', () => {
      const categories = new Set(entries.map(e => e.category));
      expect(categories.has('Query Execution')).toBe(true);
      expect(categories.has('Connection')).toBe(true);
      expect(categories.has('Navigation')).toBe(true);
      expect(categories.size).toBe(3);
    });

    it('includes Run Query keybinding from package.json', () => {
      const runQuery = entries.find(e => e.command === 'sqlServer.runQuery');
      expect(runQuery).toBeDefined();
      expect(runQuery!.label).toBe('Run Query');
      expect(runQuery!.keybinding).toBe('Ctrl+Shift+E');
      expect(runQuery!.category).toBe('Query Execution');
    });

    it('includes Cancel Query keybinding from package.json', () => {
      const cancelQuery = entries.find(e => e.command === 'sqlServer.cancelQuery');
      expect(cancelQuery).toBeDefined();
      expect(cancelQuery!.label).toBe('Cancel Query');
      expect(cancelQuery!.keybinding).toBe('Ctrl+Shift+Q');
      expect(cancelQuery!.category).toBe('Query Execution');
    });

    it('includes Run Current Statement keybinding from package.json', () => {
      const runStatement = entries.find(e => e.command === 'sqlServer.runCurrentStatement');
      expect(runStatement).toBeDefined();
      expect(runStatement!.label).toBe('Run Current Statement');
      expect(runStatement!.keybinding).toBe('Ctrl+Enter');
      expect(runStatement!.category).toBe('Query Execution');
    });

    it('includes Show Keyboard Shortcuts keybinding from package.json', () => {
      const showShortcuts = entries.find(e => e.command === 'sqlServer.showKeyboardShortcuts');
      expect(showShortcuts).toBeDefined();
      expect(showShortcuts!.label).toBe('Show Keyboard Shortcuts');
      expect(showShortcuts!.keybinding).toBe('Ctrl+Shift+/');
      expect(showShortcuts!.category).toBe('Navigation');
    });

    it('each entry has all required fields', () => {
      for (const entry of entries) {
        expect(entry).toHaveProperty('label');
        expect(entry).toHaveProperty('keybinding');
        expect(entry).toHaveProperty('command');
        expect(entry).toHaveProperty('category');
        expect(entry).toHaveProperty('isDefault');
        expect(typeof entry.label).toBe('string');
        expect(typeof entry.keybinding).toBe('string');
        expect(typeof entry.command).toBe('string');
        expect(typeof entry.isDefault).toBe('boolean');
        expect(['Query Execution', 'Connection', 'Navigation']).toContain(entry.category);
      }
    });

    it('default entries (registered keybindings) have isDefault: true', () => {
      const defaultCommands = [
        'sqlServer.runQuery',
        'sqlServer.cancelQuery',
        'sqlServer.runCurrentStatement',
        'sqlServer.showKeyboardShortcuts',
      ];
      for (const cmd of defaultCommands) {
        const entry = entries.find(e => e.command === cmd);
        expect(entry).toBeDefined();
        expect(entry!.isDefault).toBe(true);
      }
    });

    it('proposed entries have isDefault: false', () => {
      const proposedEntries = entries.filter(e => !e.isDefault);
      expect(proposedEntries.length).toBeGreaterThan(0);
      for (const entry of proposedEntries) {
        expect(entry.isDefault).toBe(false);
      }
    });

    it('has no duplicate commands in the list', () => {
      const commands = entries.map(e => e.command);
      const uniqueCommands = new Set(commands);
      expect(uniqueCommands.size).toBe(commands.length);
    });

    it('all commands reference valid sqlServer.* command IDs', () => {
      for (const entry of entries) {
        expect(entry.command).toMatch(/^sqlServer\./);
      }
    });
  });
});
