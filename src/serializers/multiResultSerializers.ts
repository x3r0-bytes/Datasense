import { ResultSet } from '../types';
import { serializeToCsv } from './csvSerializer';
import { serializeToInsert } from './insertSerializer';
import { serializeToCreateInsert } from './createInsertSerializer';
import { serializeToTextTable } from './textTableSerializer';
import { serializeToMarkdownTable } from './markdownTableSerializer';
import { mapSqlValueToJson } from './jsonSerializer';

// ─── Excel worksheet name helpers ──────────────────────────────────────────

/** Maximum length for an Excel worksheet name (Excel limit). */
const MAX_SHEET_NAME_LENGTH = 31;

/**
 * Truncates a string to at most 31 characters (the Excel worksheet name limit).
 * If the input is ≤31 characters it is returned unchanged.
 * Pure function — no side effects.
 */
export function truncateWorksheetName(label: string): string {
    if (label.length <= MAX_SHEET_NAME_LENGTH) {
        return label;
    }
    return label.slice(0, MAX_SHEET_NAME_LENGTH);
}

/**
 * Resolves worksheet name collisions by appending a numeric suffix.
 * Given a desired name and the set of names already used, returns a name
 * that is not in the used set.
 *
 * Collision strategy: append " (N)" where N starts at 2.
 * The suffixed name is also truncated to 31 characters if necessary.
 *
 * Examples:
 *   "Result 1", {} → "Result 1"
 *   "Result 1", {"Result 1"} → "Result 1 (2)"
 *   "Result 1", {"Result 1", "Result 1 (2)"} → "Result 1 (3)"
 *
 * Pure function.
 */
export function resolveWorksheetName(desiredName: string, usedNames: Set<string>): string {
    if (!usedNames.has(desiredName)) {
        return desiredName;
    }

    let counter = 2;
    while (true) {
        const suffix = ` (${counter})`;
        // Build candidate, ensuring total length ≤ 31
        let base = desiredName;
        if ((base + suffix).length > MAX_SHEET_NAME_LENGTH) {
            base = base.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length);
        }
        const candidate = base + suffix;
        if (!usedNames.has(candidate)) {
            return candidate;
        }
        counter++;
    }
}

// ─── CSV ───────────────────────────────────────────────────────────────────

/**
 * Serializes multiple result sets to a single CSV string.
 *
 * Concatenation strategy (Requirement 1.4):
 * - First result set: full CSV (header + data rows)
 * - Each subsequent result set: blank line + full CSV (header + data rows)
 *
 * The blank line separator uses CRLF to match RFC 4180 line endings used by
 * the individual CSV serializer.
 *
 * Pure function.
 */
export function serializeAllCsv(resultSets: ResultSet[]): string {
    if (resultSets.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (const rs of resultSets) {
        parts.push(serializeToCsv(rs));
    }

    // Join with blank line (CRLF blank line between each block)
    // serializeToCsv already ends with \r\n, so we add one more \r\n for the blank line
    return parts.join('\r\n');
}

// ─── JSON ──────────────────────────────────────────────────────────────────

/**
 * Serializes multiple result sets to JSON "All Results" format.
 *
 * Output (Requirement 1.5):
 *   [{ "label": "Result 1", "rows": [{...}, ...] }, ...]
 *
 * Each row is an object keyed by column name with type-mapped values
 * (same mapping as the single-result JSON serializer).
 *
 * Pure function.
 */
export function serializeAllJson(resultSets: ResultSet[], labels: string[]): string {
    const items = resultSets.map((rs, idx) => {
        const label = labels[idx] ?? `Result ${idx + 1}`;
        const rows = (rs.rows ?? []).map(row => {
            const obj: Record<string, any> = {};
            (rs.columns ?? []).forEach((col, i) => {
                obj[col.name] = mapSqlValueToJson(row[i], col.dataType);
            });
            return obj;
        });
        return { label, rows };
    });

    return JSON.stringify(items, null, 2);
}

// ─── SQL (INSERT / CREATE+INSERT) ──────────────────────────────────────────

/**
 * Serializes multiple result sets to INSERT SQL with GO separators.
 *
 * Concatenation strategy (Requirement 1.7):
 *   <block1>\n\nGO\n\n<block2>\n\nGO\n\n<block3>
 *
 * Between consecutive blocks: blank line, "GO" on its own line, blank line.
 * Pure function.
 */
export function serializeAllInsert(resultSets: ResultSet[]): string {
    if (resultSets.length === 0) {
        return '';
    }

    const blocks = resultSets.map(rs => serializeToInsert(rs));
    return joinSqlBlocks(blocks);
}

/**
 * Serializes multiple result sets to CREATE+INSERT SQL with GO separators.
 *
 * Concatenation strategy (Requirement 1.7):
 * Same as serializeAllInsert — blank line + GO + blank line between blocks.
 * Pure function.
 */
export function serializeAllCreateInsert(resultSets: ResultSet[]): string {
    if (resultSets.length === 0) {
        return '';
    }

    const blocks = resultSets.map(rs => serializeToCreateInsert(rs));
    return joinSqlBlocks(blocks);
}

/**
 * Joins SQL blocks with the required separator: blank line + GO + blank line.
 * The separator is `\n\nGO\n\n` (two newlines before GO, two after).
 * Pure function.
 */
export function joinSqlBlocks(blocks: string[]): string {
    // Normalise trailing newlines so we always get exactly:
    //   <block>\n\nGO\n\n<block>
    // Each block from the serializers ends with \n already.
    // Strip trailing whitespace/newlines from each block, then join.
    const trimmed = blocks.map(b => b.replace(/\s+$/, ''));
    return trimmed.join('\n\nGO\n\n') + '\n';
}

// ─── Text (clipboard) ──────────────────────────────────────────────────────

/**
 * Serializes multiple result sets to plain text for clipboard.
 *
 * Concatenation strategy (Requirement 1.8):
 * - First result set: just the text table
 * - Each subsequent result set: blank line + heading line containing label + text table
 *
 * The heading line format is: `-- <label>` (uses SQL-style comment as heading).
 * Pure function.
 */
export function serializeAllText(resultSets: ResultSet[], labels: string[]): string {
    if (resultSets.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (let i = 0; i < resultSets.length; i++) {
        const label = labels[i] ?? `Result ${i + 1}`;
        const tableText = serializeToTextTable(resultSets[i]);

        if (i === 0) {
            parts.push(tableText);
        } else {
            // blank line + heading line + table
            parts.push(`\n-- ${label}\n${tableText}`);
        }
    }

    return parts.join('');
}


// ─── Markdown (clipboard) ──────────────────────────────────────────────────

/**
 * Serializes multiple result sets to Markdown tables for clipboard.
 *
 * Concatenation strategy:
 * - First result set: just the markdown table
 * - Each subsequent result set: blank line + heading (## label) + markdown table
 *
 * Pure function.
 */
export function serializeAllMarkdown(resultSets: ResultSet[], labels: string[]): string {
    if (resultSets.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (let i = 0; i < resultSets.length; i++) {
        const label = labels[i] ?? `Result ${i + 1}`;
        const tableText = serializeToMarkdownTable(resultSets[i]);

        if (i === 0) {
            parts.push(tableText);
        } else {
            // blank line + heading + blank line + table
            parts.push(`\n\n## ${label}\n\n${tableText}`);
        }
    }

    return parts.join('');
}
