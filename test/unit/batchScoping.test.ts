import { describe, it, expect } from 'vitest';
import { extractCurrentBatch } from '../../server/src/completionProvider';

describe('extractCurrentBatch — edge cases', () => {
  it('empty document returns { text: "", startOffset: 0 }', () => {
    const result = extractCurrentBatch('', 0);
    expect(result).toEqual({ text: '', startOffset: 0 });
  });

  it('single-batch document (no GO) returns entire document', () => {
    const doc = 'SELECT *\nFROM Orders\nWHERE Status = 1';
    const cursor = 15; // somewhere in the middle
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe(doc);
    expect(result.startOffset).toBe(0);
  });

  it('cursor on GO line itself returns batch before the GO', () => {
    const doc = 'SELECT 1\nGO\nSELECT 2';
    // "SELECT 1\n" = 9 chars, GO starts at offset 9
    const cursorOnGo = 9; // start of the GO line
    const result = extractCurrentBatch(doc, cursorOnGo);
    expect(result.text).toBe('SELECT 1');
    expect(result.startOffset).toBe(0);
  });

  it('cursor in the middle of GO line returns batch before the GO', () => {
    const doc = 'SELECT 1\nGO\nSELECT 2';
    // GO line starts at offset 9, cursor at offset 10 (on the 'O' of GO)
    const cursorMidGo = 10;
    const result = extractCurrentBatch(doc, cursorMidGo);
    expect(result.text).toBe('SELECT 1');
    expect(result.startOffset).toBe(0);
  });

  it('GO with repeat count (e.g., GO 5) is recognized as separator', () => {
    const doc = 'SELECT 1\nGO 5\nSELECT 2';
    // Cursor in second batch: "SELECT 1\n" = 9, "GO 5\n" = 5, so offset 14
    const cursor = 14;
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe('SELECT 2');
    expect(result.startOffset).toBe(14);
  });

  it('GO with large repeat count (GO 100) is recognized as separator', () => {
    const doc = 'INSERT INTO T VALUES(1)\nGO 100\nSELECT 2';
    // "INSERT INTO T VALUES(1)\n" = 24, "GO 100\n" = 7, so offset 31
    const cursor = 31;
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe('SELECT 2');
    expect(result.startOffset).toBe(31);
  });

  describe('malformed GO lines are NOT separators', () => {
    it('GO; is not a separator', () => {
      const doc = 'SELECT 1\nGO;\nSELECT 2';
      const cursor = 14; // in "SELECT 2" area
      const result = extractCurrentBatch(doc, cursor);
      // The entire document is one batch since GO; is not a valid separator
      expect(result.text).toBe(doc);
      expect(result.startOffset).toBe(0);
    });

    it('GO SELECT is not a separator', () => {
      const doc = 'SELECT 1\nGO SELECT\nSELECT 2';
      const cursor = 20; // in "SELECT 2" area
      const result = extractCurrentBatch(doc, cursor);
      expect(result.text).toBe(doc);
      expect(result.startOffset).toBe(0);
    });

    it('GOPHER is not a separator', () => {
      const doc = 'SELECT 1\nGOPHER\nSELECT 2';
      const cursor = 16; // in "SELECT 2" area
      const result = extractCurrentBatch(doc, cursor);
      expect(result.text).toBe(doc);
      expect(result.startOffset).toBe(0);
    });

    it('GO with trailing text (GOx) is not a separator', () => {
      const doc = 'SELECT 1\nGOx\nSELECT 2';
      const cursor = 13; // in "SELECT 2" area
      const result = extractCurrentBatch(doc, cursor);
      expect(result.text).toBe(doc);
      expect(result.startOffset).toBe(0);
    });
  });

  it('unclosed block comment spanning batches — GO inside comment is ignored', () => {
    // Block comment starts before GO and is never closed
    const doc = '/* start comment\nGO\nstill in comment */\nSELECT 1';
    // The GO on line 2 is inside a block comment, so it's not a separator
    // The entire document is one batch
    const cursor = 40; // in "SELECT 1" area
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe(doc);
    expect(result.startOffset).toBe(0);
  });

  it('closed block comment with GO inside — GO is ignored', () => {
    const doc = '/* comment\nGO\nend */\nSELECT 1\nGO\nSELECT 2';
    // First GO (line 1) is inside block comment — not a separator
    // Second GO (after SELECT 1) is a real separator
    const cursor = doc.indexOf('SELECT 2');
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe('SELECT 2');
  });

  it('GO inside a string literal is not a separator', () => {
    const doc = "SELECT 'GO'\nGO\nSELECT 2";
    // The GO inside the string is on the same line as SELECT, not standalone
    // The standalone GO on line 2 IS a separator
    const cursor = doc.indexOf('SELECT 2');
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe('SELECT 2');
  });

  it('multi-line string containing GO on its own line — GO is not a separator', () => {
    const doc = "SELECT '\nGO\n' AS val\nGO\nSELECT 2";
    // The first GO is inside a string literal spanning lines — not a separator
    // The second GO is a real separator
    const cursor = doc.indexOf('SELECT 2');
    const result = extractCurrentBatch(doc, cursor);
    expect(result.text).toBe('SELECT 2');
  });
});
