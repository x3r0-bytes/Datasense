// Unit tests for multi-result export (Task 5.3)
// Validates Requirements 1.1, 1.2, 1.9, 1.11

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ──────────────────────────────────────────────────────────────
// vi.mock is hoisted — all references inside the factory must use vi.fn() inline.

vi.mock('vscode', () => ({
    window: {
        showQuickPick: vi.fn(),
        showSaveDialog: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: {
        fs: {
            writeFile: vi.fn(),
        },
    },
    env: {
        clipboard: {
            writeText: vi.fn(),
        },
    },
    Uri: {
        file: vi.fn((path: string) => ({ fsPath: path })),
    },
}));

// ─── Mock ExcelJS so we never touch the filesystem ──────────────────────────
vi.mock('exceljs', () => {
    const MockWorksheet = class {
        name = '';
        rows: any[] = [];
        addRow(row: any) {
            this.rows.push(row);
            return {
                getCell: vi.fn(() => ({ numFmt: '' })),
            };
        }
    };

    const MockWorkbook = class {
        private sheets: any[] = [];
        addWorksheet(name: string) {
            const ws = new MockWorksheet();
            ws.name = name;
            this.sheets.push(ws);
            return ws;
        }
        get worksheetNames() {
            return this.sheets.map((s) => s.name);
        }
        xlsx = {
            writeBuffer: vi.fn().mockResolvedValue(Buffer.from([])),
        };
    };

    return { default: { Workbook: MockWorkbook } };
});

import * as vscode from 'vscode';
import { ExportManager } from '../../src/exportManager';
import { truncateWorksheetName, resolveWorksheetName } from '../../src/serializers/multiResultSerializers';
import { ResultSet } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResultSet(rowCount = 2): ResultSet {
    return {
        columns: [
            { name: 'Id', dataType: 'int' },
            { name: 'Name', dataType: 'varchar' },
        ],
        rows: Array.from({ length: rowCount }, (_, i) => [i + 1, `Row ${i + 1}`]),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExportManager.exportWithSelection', () => {
    let manager: ExportManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new ExportManager();

        // Default: save dialog returns a URI so file writes don't abort
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(
            vscode.Uri.file('/tmp/results.csv') as any
        );
        vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);
    });

    // =========================================================================
    // Requirement 1.9 — Single result set bypasses the quick pick
    // =========================================================================

    describe('single result set — bypass quick pick (Requirement 1.9)', () => {
        it('does not call showQuickPick when there is exactly one result set', async () => {
            await manager.exportWithSelection('csv', [makeResultSet()], ['Result 1']);

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        });

        it('calls the underlying exportResults without a prompt for a single set', async () => {
            // Spy on exportResults to confirm it is called directly
            const spy = vi.spyOn(manager, 'exportResults');

            await manager.exportWithSelection('csv', [makeResultSet()], ['Result 1']);

            expect(spy).toHaveBeenCalledOnce();
        });

        it('exports the single result set (not "all") when only one set exists', async () => {
            const spy = vi.spyOn(manager, 'exportAllResults');

            await manager.exportWithSelection('csv', [makeResultSet()], ['Result 1']);

            // exportAllResults must NOT be called for a single result set
            expect(spy).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Requirement 1.1 — Quick pick lists all labels plus "All Results"
    // =========================================================================

    describe('multi-result quick pick content (Requirement 1.1)', () => {
        it('shows a quick pick when there are two result sets', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(vscode.window.showQuickPick).toHaveBeenCalledOnce();
        });

        it('includes one item per result set label in the quick pick', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2', 'Result 3']
            );

            const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [any[], any];
            const labels: string[] = items.map((i: any) => i.label);

            expect(labels).toContain('Result 1');
            expect(labels).toContain('Result 2');
            expect(labels).toContain('Result 3');
        });

        it('includes an "All Results" item as the last item in the quick pick', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [any[], any];
            const lastItem = items[items.length - 1];

            expect(lastItem.label).toBe('All Results');
        });

        it('quick pick has N+1 items for N result sets (N labels + "All Results")', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            const n = 4;
            await manager.exportWithSelection(
                'csv',
                Array.from({ length: n }, () => makeResultSet()),
                Array.from({ length: n }, (_, i) => `Result ${i + 1}`)
            );

            const [items] = vi.mocked(vscode.window.showQuickPick).mock.calls[0] as [any[], any];
            expect(items).toHaveLength(n + 1);
        });
    });

    // =========================================================================
    // Requirement 1.11 — Dismissing the quick pick produces no output
    // =========================================================================

    describe('quick pick dismissed — no output (Requirement 1.11)', () => {
        it('produces no file write when the quick pick is dismissed (undefined)', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
        });

        it('does not open a save dialog when the quick pick is dismissed', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'json',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
        });

        it('does not write to clipboard when the quick pick is dismissed for text format', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

            await manager.exportWithSelection(
                'text',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Requirement 1.2 — Selecting a specific result set calls exportResults
    // =========================================================================

    describe('select specific result set (Requirement 1.2)', () => {
        it('calls exportResults with the correct result set when index 0 is selected', async () => {
            const rs0 = makeResultSet(1);
            const rs1 = makeResultSet(3);

            vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
                label: 'Result 1',
                resultIndex: 0,
            } as any);

            const spy = vi.spyOn(manager, 'exportResults');

            await manager.exportWithSelection('csv', [rs0, rs1], ['Result 1', 'Result 2']);

            expect(spy).toHaveBeenCalledOnce();
            expect(spy).toHaveBeenCalledWith('csv', rs0);
        });

        it('calls exportResults with the correct result set when index 1 is selected', async () => {
            const rs0 = makeResultSet(1);
            const rs1 = makeResultSet(3);

            vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
                label: 'Result 2',
                resultIndex: 1,
            } as any);

            const spy = vi.spyOn(manager, 'exportResults');

            await manager.exportWithSelection('csv', [rs0, rs1], ['Result 1', 'Result 2']);

            expect(spy).toHaveBeenCalledWith('csv', rs1);
        });

        it('does NOT call exportAllResults when a specific result set is selected', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
                label: 'Result 1',
                resultIndex: 0,
            } as any);

            const spy = vi.spyOn(manager, 'exportAllResults');

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(spy).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Requirement 1.3 — Selecting "All Results" calls exportAllResults
    // =========================================================================

    describe('select "All Results" (Requirement 1.3)', () => {
        it('calls exportAllResults when "All Results" is selected', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
                label: 'All Results',
                resultIndex: 'all',
            } as any);

            const spy = vi.spyOn(manager, 'exportAllResults');

            const sets = [makeResultSet(), makeResultSet()];
            const labels = ['Result 1', 'Result 2'];

            await manager.exportWithSelection('csv', sets, labels);

            expect(spy).toHaveBeenCalledOnce();
            expect(spy).toHaveBeenCalledWith('csv', sets, labels);
        });

        it('does NOT call exportResults for a specific set when "All Results" is selected', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
                label: 'All Results',
                resultIndex: 'all',
            } as any);

            const spy = vi.spyOn(manager, 'exportResults');

            await manager.exportWithSelection(
                'csv',
                [makeResultSet(), makeResultSet()],
                ['Result 1', 'Result 2']
            );

            expect(spy).not.toHaveBeenCalled();
        });
    });
});

// ─── Pure helper tests (no mocks required) ───────────────────────────────────

describe('truncateWorksheetName', () => {
    // =========================================================================
    // Requirement 1.6 — Excel worksheet name truncation to 31 characters
    // =========================================================================

    it('returns the label unchanged when it is exactly 31 characters', () => {
        const label = 'A'.repeat(31);
        expect(truncateWorksheetName(label)).toBe(label);
        expect(truncateWorksheetName(label)).toHaveLength(31);
    });

    it('returns the label unchanged when it is shorter than 31 characters', () => {
        const label = 'Short Label';
        expect(truncateWorksheetName(label)).toBe(label);
    });

    it('truncates a label longer than 31 characters to exactly 31 characters', () => {
        const label = 'A'.repeat(50);
        const result = truncateWorksheetName(label);
        expect(result).toHaveLength(31);
    });

    it('truncates to the first 31 characters of the input', () => {
        const label = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456';  // 33 chars
        const result = truncateWorksheetName(label);
        expect(result).toBe(label.slice(0, 31));
    });

    it('returns an empty string unchanged', () => {
        expect(truncateWorksheetName('')).toBe('');
    });

    it('a label of exactly 32 characters is truncated to 31', () => {
        const label = 'A'.repeat(32);
        expect(truncateWorksheetName(label)).toHaveLength(31);
    });
});

describe('resolveWorksheetName', () => {
    // =========================================================================
    // Requirement 1.6 — Excel worksheet name collision appends a numeric suffix
    // =========================================================================

    it('returns the desired name when it is not in the used set', () => {
        expect(resolveWorksheetName('Result 1', new Set())).toBe('Result 1');
    });

    it('appends " (2)" when the desired name is already used', () => {
        const used = new Set(['Result 1']);
        expect(resolveWorksheetName('Result 1', used)).toBe('Result 1 (2)');
    });

    it('appends " (3)" when both the base name and " (2)" are already used', () => {
        const used = new Set(['Result 1', 'Result 1 (2)']);
        expect(resolveWorksheetName('Result 1', used)).toBe('Result 1 (3)');
    });

    it('increments the counter until a free name is found', () => {
        const used = new Set(['Result 1', 'Result 1 (2)', 'Result 1 (3)', 'Result 1 (4)']);
        expect(resolveWorksheetName('Result 1', used)).toBe('Result 1 (5)');
    });

    it('returns a different name from all previously used names', () => {
        const used = new Set<string>();
        const names: string[] = [];

        for (let i = 0; i < 5; i++) {
            const name = resolveWorksheetName('Sheet', used);
            expect(used.has(name)).toBe(false);
            used.add(name);
            names.push(name);
        }

        // All generated names must be distinct
        expect(new Set(names).size).toBe(5);
    });

    it('result is always at most 31 characters even when suffix is appended', () => {
        // Long base name (31 chars) + suffix would exceed limit — must truncate base
        const longName = 'A'.repeat(31);
        const used = new Set([longName]);
        const result = resolveWorksheetName(longName, used);
        expect(result.length).toBeLessThanOrEqual(31);
    });

    it('the returned name is not the same as the original when there is a collision', () => {
        const used = new Set(['MySheet']);
        const result = resolveWorksheetName('MySheet', used);
        expect(result).not.toBe('MySheet');
    });
});
