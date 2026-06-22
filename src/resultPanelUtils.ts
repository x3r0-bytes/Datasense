/**
 * Pure utility functions for result panel sorting and filtering.
 * These are exported so property tests can import and validate them directly.
 *
 * Rows are represented as `any[][]` — an array of rows, where each row is an array of cell values.
 */

/**
 * Sorts rows by the value at the given column index.
 * Returns a new sorted array (does not mutate the input).
 *
 * @param rows - The rows to sort (array of arrays)
 * @param columnIndex - The column index to sort by
 * @param direction - 'asc' for ascending, 'desc' for descending
 * @returns A new array of rows sorted by the specified column
 */
export function sortRows(rows: any[][], columnIndex: number, direction: 'asc' | 'desc'): any[][] {
  const sorted = [...rows].sort((a, b) => {
    const valA = a[columnIndex];
    const valB = b[columnIndex];

    // Handle null/undefined — push them to the end regardless of direction
    if (valA == null && valB == null) { return 0; }
    if (valA == null) { return 1; }
    if (valB == null) { return -1; }

    // Numeric comparison if both values are numbers
    if (typeof valA === 'number' && typeof valB === 'number') {
      return direction === 'asc' ? valA - valB : valB - valA;
    }

    // String comparison (case-insensitive)
    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();

    if (strA < strB) { return direction === 'asc' ? -1 : 1; }
    if (strA > strB) { return direction === 'asc' ? 1 : -1; }
    return 0;
  });

  return sorted;
}

/**
 * Filters rows where the cell at the given column index contains the filter text (case-insensitive).
 * Returns a new array containing only matching rows.
 *
 * @param rows - The rows to filter (array of arrays)
 * @param columnIndex - The column index to filter on
 * @param filterText - The text to match (case-insensitive substring match)
 * @returns A new array of rows where the specified column contains the filter text
 */
export function filterRows(rows: any[][], columnIndex: number, filterText: string): any[][] {
  if (!filterText) {
    return [...rows];
  }

  const lowerFilter = filterText.toLowerCase();

  return rows.filter((row) => {
    const cell = row[columnIndex];
    if (cell == null) {
      return 'null'.includes(lowerFilter);
    }
    return String(cell).toLowerCase().includes(lowerFilter);
  });
}

/**
 * Filters rows by performing a case-insensitive text match across ALL columns.
 * If any cell in a row contains the filter text (substring match), the row is included.
 * Returns a new array containing only matching rows.
 *
 * @param rows - The rows to filter (array of arrays)
 * @param filterText - The text to match (case-insensitive substring match across all columns)
 * @returns A new array of rows where at least one column contains the filter text
 */
export function globalFilterRows(rows: any[][], filterText: string): any[][] {
  if (!filterText) {
    return [...rows];
  }

  const lowerFilter = filterText.toLowerCase();

  return rows.filter((row) =>
    row.some((cell) => {
      if (cell == null) {
        return 'null'.includes(lowerFilter);
      }
      return String(cell).toLowerCase().includes(lowerFilter);
    })
  );
}

/**
 * Calculates new column width after a drag operation.
 * Clamps to minimum 50px.
 *
 * @param startWidth - Column width at drag start (px)
 * @param dragDelta - Horizontal pixels moved from drag start (positive = wider)
 * @returns New column width (minimum 50px)
 */
export function calculateColumnWidth(startWidth: number, dragDelta: number): number {
  return Math.max(50, startWidth + dragDelta);
}

/**
 * Calculates auto-fit width for a column based on cell content.
 * Returns the width needed to fit the widest content + 16px padding.
 * Clamps to minimum 50px.
 *
 * @param cellTexts - Array of string representations of all cells in the column (including header)
 * @param charWidth - Approximate character width in pixels (based on font metrics)
 * @returns Optimal column width in pixels (minimum 50px)
 */
export function calculateAutoFitWidth(cellTexts: string[], charWidth: number): number {
  if (cellTexts.length === 0) {
    return 50;
  }

  const longestTextLength = Math.max(...cellTexts.map(text => text.length));
  return Math.max(50, longestTextLength * charWidth + 16);
}

/**
 * Detects whether a cell value contains XML content.
 * Returns true if the trimmed value starts with '<?xml' (case-insensitive)
 * or '<' followed by a letter (root element tag).
 *
 * @param value - The cell value to check
 * @returns true if the value appears to be XML content, false otherwise
 */
export function isXmlContent(value: string | null | undefined): boolean {
  if (value == null || value === '') {
    return false;
  }

  const trimmed = value.trimStart();
  if (trimmed.length === 0) {
    return false;
  }

  // Match <?xml (case-insensitive)
  if (trimmed.toLowerCase().startsWith('<?xml')) {
    return true;
  }

  // Match '<' followed by a letter
  if (trimmed.length >= 2 && trimmed[0] === '<' && /[a-zA-Z]/.test(trimmed[1])) {
    return true;
  }

  return false;
}
