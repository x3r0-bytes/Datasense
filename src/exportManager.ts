import * as vscode from 'vscode';
import { ResultSet } from './types';
import { ExportFormat } from './webviewProtocol';
import { serializeToCsv } from './serializers/csvSerializer';
import { serializeToJson } from './serializers/jsonSerializer';
import { serializeToInsert } from './serializers/insertSerializer';
import { serializeToCreateInsert } from './serializers/createInsertSerializer';
import { serializeToTextTable } from './serializers/textTableSerializer';
import { serializeToMarkdownTable } from './serializers/markdownTableSerializer';
import {
    serializeAllCsv,
    serializeAllJson,
    serializeAllInsert,
    serializeAllCreateInsert,
    serializeAllText,
    serializeAllMarkdown,
    truncateWorksheetName,
    resolveWorksheetName,
} from './serializers/multiResultSerializers';
import * as ExcelJS from 'exceljs';

/**
 * Quick pick item used for result set selection.
 * `resultIndex` identifies which result set to export:
 *  - a numeric index selects a specific result set from the array
 *  - 'all' triggers exportAllResults() for combined output
 */
export interface ExportQuickPickItem extends vscode.QuickPickItem {
    resultIndex: number | 'all';
}

/**
 * Manages export of query result sets to various formats.
 * Dispatches to the appropriate serializer based on the requested format,
 * handles save dialogs, file writes, clipboard operations, and error reporting.
 */
export class ExportManager {

    /**
     * Entry point for export commands triggered from the result panel title bar.
     *
     * Handles the multi-result selection flow:
     * - Single result set: exports directly without showing a quick pick prompt (Req 1.9)
     * - Multiple result sets: shows a quick pick listing each label plus "All Results" (Req 1.1)
     * - Quick pick dismissed: cancels the operation with no output (Req 1.11)
     * - Specific result selected: exports only that result set (Req 1.2)
     * - "All Results" selected: exports all result sets using per-format concatenation (Req 1.3)
     *
     * @param format  The export format to use
     * @param resultSets  Array of result sets from the current query
     * @param labels  Display labels for each result set (e.g. "Result 1", "Batch 2 - Result 1")
     */
    async exportWithSelection(
        format: ExportFormat,
        resultSets: ResultSet[],
        labels: string[]
    ): Promise<void> {
        // Single result set — skip the quick pick prompt entirely (Req 1.9)
        if (resultSets.length === 1) {
            return this.exportResults(format, resultSets[0]);
        }

        // Build quick pick items: one per result set label, then "All Results"
        const items: ExportQuickPickItem[] = [
            ...labels.map((label, index) => ({
                label,
                resultIndex: index as number | 'all'
            })),
            {
                label: 'All Results',
                resultIndex: 'all' as const
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select which result set to export'
        });

        // User dismissed the quick pick — cancel with no output (Req 1.11)
        if (!selected) {
            return;
        }

        if (selected.resultIndex === 'all') {
            // Export all result sets using per-format concatenation strategies (Req 1.3)
            return this.exportAllResults(format, resultSets, labels);
        } else {
            // Export only the selected result set (Req 1.2)
            return this.exportResults(format, resultSets[selected.resultIndex]);
        }
    }

    /**
     * Generates a default filename with timestamp for the given export format.
     *
     * Naming conventions:
     * - CSV:            results_YYYYMMDD_HHmmss.csv
     * - JSON:           results_YYYYMMDD_HHmmss.json
     * - Excel:          results_YYYYMMDD_HHmmss.xlsx
     * - INSERT:         insert_YYYYMMDD_HHmmss.sql
     * - CREATE+INSERT:  create_insert_YYYYMMDD_HHmmss.sql
     * - Text:           (not used — clipboard copy)
     */
    generateFilename(format: ExportFormat): string {
        const now = new Date();
        const timestamp = this.formatTimestamp(now);

        switch (format) {
            case 'csv':
                return `results_${timestamp}.csv`;
            case 'json':
                return `results_${timestamp}.json`;
            case 'excel':
                return `results_${timestamp}.xlsx`;
            case 'insert':
                return `insert_${timestamp}.sql`;
            case 'createInsert':
                return `create_insert_${timestamp}.sql`;
            case 'text':
                return `results_${timestamp}.txt`;
            case 'markdown':
                return `results_${timestamp}.md`;
        }
    }

    /**
     * Dispatches export based on the requested format.
     *
     * - CSV/JSON/INSERT/CREATE+INSERT: serialize → save dialog → write file
     * - Excel: generate .xlsx via exceljs → save dialog → write buffer
     * - Text: serialize → copy to clipboard → show confirmation message
     */
    async exportResults(format: ExportFormat, resultSet: ResultSet): Promise<void> {
        switch (format) {
            case 'csv':
                return this.exportToFile(resultSet, format, { 'CSV': ['csv'] });
            case 'json':
                return this.exportToFile(resultSet, format, { 'JSON': ['json'] });
            case 'insert':
                return this.exportInsert(resultSet);
            case 'createInsert':
                return this.exportToFile(resultSet, format, { 'SQL': ['sql'] });
            case 'excel':
                return this.exportToExcel(resultSet);
            case 'text':
                return this.exportToClipboard(resultSet);
            case 'markdown':
                return this.exportToClipboardMarkdown(resultSet);
        }
    }

    /**
     * Exports all result sets into a single output using format-specific
     * concatenation strategies. Called when the user selects "All Results"
     * from the export quick pick.
     *
     * Concatenation strategies (Requirements 1.4–1.8):
     * - CSV:             blank line + new header row before each subsequent set
     * - JSON:            [{label, rows}, …] array
     * - Excel:           one worksheet per result set, name = label ≤31 chars
     * - INSERT / CREATE+INSERT: blank line + GO + blank line between sets
     * - Text (clipboard): blank line + heading line with label before each subsequent set
     */
    async exportAllResults(
        format: ExportFormat,
        resultSets: ResultSet[],
        labels: string[]
    ): Promise<void> {
        switch (format) {
            case 'csv': {
                const content = serializeAllCsv(resultSets);
                await this.saveContentToFile(content, format, { 'CSV': ['csv'] });
                break;
            }
            case 'json': {
                const content = serializeAllJson(resultSets, labels);
                await this.saveContentToFile(content, format, { 'JSON': ['json'] });
                break;
            }
            case 'insert': {
                const content = serializeAllInsert(resultSets);
                await this.saveContentToFile(content, format, { 'SQL': ['sql'] });
                break;
            }
            case 'createInsert': {
                const content = serializeAllCreateInsert(resultSets);
                await this.saveContentToFile(content, format, { 'SQL': ['sql'] });
                break;
            }
            case 'excel':
                await this.exportAllToExcel(resultSets, labels);
                break;
            case 'text':
                await this.exportAllToClipboard(resultSets, labels);
                break;
            case 'markdown':
                await this.exportAllToClipboardMarkdown(resultSets, labels);
                break;
        }
    }

    /**
     * Exports text-based formats (CSV, JSON, CREATE+INSERT) to a file via save dialog.
     */
    private async exportToFile(
        resultSet: ResultSet,
        format: ExportFormat,
        filters: Record<string, string[]>
    ): Promise<void> {
        const content = this.serialize(resultSet, format);
        const defaultFilename = this.generateFilename(format);

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFilename),
            filters
        });

        // User cancelled save dialog
        if (!uri) {
            return;
        }

        try {
            const encoded = Buffer.from(content, 'utf-8');
            await vscode.workspace.fs.writeFile(uri, encoded);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Export failed: ${err.message || err}`);
        }
    }

    /**
     * Handles INSERT export with zero-row check.
     * Zero rows → show info message and return without opening save dialog.
     */
    private async exportInsert(resultSet: ResultSet): Promise<void> {
        if (!resultSet.rows || resultSet.rows.length === 0) {
            vscode.window.showInformationMessage('No data to export');
            return;
        }

        return this.exportToFile(resultSet, 'insert', { 'SQL': ['sql'] });
    }

    /**
     * Exports to Excel (.xlsx) using the exceljs library.
     * Creates a workbook with a "Results" worksheet, adds headers and data rows
     * with type-appropriate formatting, then writes the buffer to disk via save dialog.
     */
    private async exportToExcel(resultSet: ResultSet): Promise<void> {
        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Results');

            // Add header row
            const headerRow = resultSet.columns.map(col => col.name);
            worksheet.addRow(headerRow);

            // Add data rows with type-appropriate cell values
            for (const row of resultSet.rows) {
                const excelRow = worksheet.addRow(
                    resultSet.columns.map((col, i) => this.formatExcelCell(row[i], col.dataType))
                );

                // Apply date formatting to date cells
                resultSet.columns.forEach((col, i) => {
                    if (row[i] !== null && row[i] !== undefined && this.isDateType(col.dataType)) {
                        const cell = excelRow.getCell(i + 1); // 1-indexed
                        cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
                    }
                });
            }

            // Write workbook to buffer
            const buffer = await workbook.xlsx.writeBuffer();

            const defaultFilename = this.generateFilename('excel');
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultFilename),
                filters: { 'Excel': ['xlsx'] }
            });

            // User cancelled save dialog
            if (!uri) {
                return;
            }

            await vscode.workspace.fs.writeFile(uri, new Uint8Array(buffer as ArrayBuffer));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Excel export failed: ${err.message || err}`);
        }
    }

    /**
     * Copies the result set as formatted text to the clipboard and shows a confirmation.
     */
    private async exportToClipboard(resultSet: ResultSet): Promise<void> {
        const content = serializeToTextTable(resultSet);
        await vscode.env.clipboard.writeText(content);

        const rowCount = resultSet.rows ? resultSet.rows.length : 0;
        vscode.window.showInformationMessage(`Copied ${rowCount} rows to clipboard`);
    }

    /**
     * Copies the result set as a Markdown table to the clipboard and shows a confirmation.
     */
    private async exportToClipboardMarkdown(resultSet: ResultSet): Promise<void> {
        const content = serializeToMarkdownTable(resultSet);
        await vscode.env.clipboard.writeText(content);

        const rowCount = resultSet.rows ? resultSet.rows.length : 0;
        vscode.window.showInformationMessage(`Copied ${rowCount} rows as Markdown to clipboard`);
    }

    /**
     * Saves pre-serialized string content to a file via save dialog.
     * Used by exportAllResults for text-based formats.
     */
    private async saveContentToFile(
        content: string,
        format: ExportFormat,
        filters: Record<string, string[]>
    ): Promise<void> {
        const defaultFilename = this.generateFilename(format);

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFilename),
            filters
        });

        if (!uri) {
            return;
        }

        try {
            const encoded = Buffer.from(content, 'utf-8');
            await vscode.workspace.fs.writeFile(uri, encoded);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Export failed: ${err.message || err}`);
        }
    }

    /**
     * Exports all result sets to a single Excel workbook with one worksheet per set.
     * Worksheet names are labels truncated to 31 characters with collision resolution.
     */
    private async exportAllToExcel(resultSets: ResultSet[], labels: string[]): Promise<void> {
        try {
            const workbook = new ExcelJS.Workbook();
            const usedNames = new Set<string>();

            for (let i = 0; i < resultSets.length; i++) {
                const rs = resultSets[i];
                const rawLabel = labels[i] ?? `Result ${i + 1}`;
                const truncatedName = truncateWorksheetName(rawLabel);
                const sheetName = resolveWorksheetName(truncatedName, usedNames);
                usedNames.add(sheetName);

                const worksheet = workbook.addWorksheet(sheetName);

                // Add header row
                const headerRow = (rs.columns ?? []).map(col => col.name);
                worksheet.addRow(headerRow);

                // Add data rows
                for (const row of rs.rows ?? []) {
                    const excelRow = worksheet.addRow(
                        (rs.columns ?? []).map((col, colIdx) =>
                            this.formatExcelCell(row[colIdx], col.dataType)
                        )
                    );

                    // Apply date formatting
                    (rs.columns ?? []).forEach((col, colIdx) => {
                        if (row[colIdx] !== null && row[colIdx] !== undefined && this.isDateType(col.dataType)) {
                            const cell = excelRow.getCell(colIdx + 1);
                            cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
                        }
                    });
                }
            }

            // Write workbook to buffer
            const buffer = await workbook.xlsx.writeBuffer();

            const defaultFilename = this.generateFilename('excel');
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultFilename),
                filters: { 'Excel': ['xlsx'] }
            });

            if (!uri) {
                return;
            }

            await vscode.workspace.fs.writeFile(uri, new Uint8Array(buffer as ArrayBuffer));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Excel export failed: ${err.message || err}`);
        }
    }

    /**
     * Copies all result sets as formatted text to the clipboard.
     * Each subsequent result set is preceded by a blank line and a heading line with its label.
     */
    private async exportAllToClipboard(resultSets: ResultSet[], labels: string[]): Promise<void> {
        const content = serializeAllText(resultSets, labels);
        await vscode.env.clipboard.writeText(content);

        const totalRows = resultSets.reduce((sum, rs) => sum + (rs.rows?.length ?? 0), 0);
        vscode.window.showInformationMessage(
            `Copied ${totalRows} rows (${resultSets.length} result sets) to clipboard`
        );
    }

    /**
     * Copies all result sets as Markdown tables to the clipboard.
     * Each subsequent result set is preceded by a heading (## label) and blank lines.
     */
    private async exportAllToClipboardMarkdown(resultSets: ResultSet[], labels: string[]): Promise<void> {
        const content = serializeAllMarkdown(resultSets, labels);
        await vscode.env.clipboard.writeText(content);

        const totalRows = resultSets.reduce((sum, rs) => sum + (rs.rows?.length ?? 0), 0);
        vscode.window.showInformationMessage(
            `Copied ${totalRows} rows (${resultSets.length} result sets) as Markdown to clipboard`
        );
    }

    /**
     * Routes serialization to the correct serializer based on format.
     */
    private serialize(resultSet: ResultSet, format: ExportFormat): string {
        switch (format) {
            case 'csv':
                return serializeToCsv(resultSet);
            case 'json':
                return serializeToJson(resultSet);
            case 'insert':
                return serializeToInsert(resultSet);
            case 'createInsert':
                return serializeToCreateInsert(resultSet);
            case 'text':
                return serializeToTextTable(resultSet);
            default:
                return '';
        }
    }

    /**
     * Formats a cell value for Excel based on the SQL data type.
     * - Date values: Date object (for proper Excel date handling)
     * - Numeric values: number
     * - NULL: undefined (empty cell)
     * - Other: string
     */
    private formatExcelCell(value: any, dataType: string): any {
        if (value === null || value === undefined) {
            return undefined;
        }

        if (this.isDateType(dataType)) {
            if (value instanceof Date) {
                return value;
            }
            // Try to parse string dates
            const parsed = new Date(value);
            if (!isNaN(parsed.getTime())) {
                return parsed;
            }
            return String(value);
        }

        if (this.isNumericType(dataType)) {
            const num = Number(value);
            if (!isNaN(num)) {
                return num;
            }
            return String(value);
        }

        return String(value);
    }

    /**
     * Checks if a SQL data type is a date/datetime type.
     */
    private isDateType(dataType: string): boolean {
        const dt = dataType.toLowerCase();
        return dt === 'date' || dt === 'datetime' || dt === 'datetime2' ||
               dt === 'datetimeoffset' || dt === 'smalldatetime' || dt === 'time';
    }

    /**
     * Checks if a SQL data type is a numeric type.
     */
    private isNumericType(dataType: string): boolean {
        const dt = dataType.toLowerCase();
        return dt === 'int' || dt === 'bigint' || dt === 'smallint' ||
               dt === 'tinyint' || dt === 'decimal' || dt === 'numeric' ||
               dt === 'float' || dt === 'real' || dt === 'money' || dt === 'smallmoney';
    }

    /**
     * Formats a Date to YYYYMMDD_HHmmss.
     */
    private formatTimestamp(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }
}
