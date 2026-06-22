import { describe, it, expect } from 'vitest';
import { splitBatches } from '../../src/batchSplitter';

describe('splitBatches', () => {
  it('should split simple batches on GO', () => {
    const sql = 'SELECT 1\nGO\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('should handle GO case-insensitively', () => {
    const sql = 'SELECT 1\ngo\nSELECT 2\nGo\nSELECT 3';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('should handle GO with surrounding whitespace', () => {
    const sql = 'SELECT 1\n  GO  \nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('should not split on GO within a single-quoted string', () => {
    const sql = "SELECT 'GO\nGO\nstill in string' AS val";
    const result = splitBatches(sql);
    expect(result).toEqual(["SELECT 'GO\nGO\nstill in string' AS val"]);
  });

  it('should not split on GO within a single-line comment', () => {
    const sql = 'SELECT 1 -- GO\nSELECT 2';
    const result = splitBatches(sql);
    // GO is part of a comment on the same line as SELECT 1, not a separator
    expect(result).toEqual(['SELECT 1 -- GO\nSELECT 2']);
  });

  it('should not split on GO within a block comment', () => {
    const sql = 'SELECT 1\n/* this is a\nGO\ncomment */\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1\n/* this is a\nGO\ncomment */\nSELECT 2']);
  });

  it('should not treat GO as separator when mixed with other text', () => {
    const sql = 'SELECT GOPHER\nGO\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT GOPHER', 'SELECT 2']);
  });

  it('should return single batch when no GO present', () => {
    const sql = 'SELECT 1\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1\nSELECT 2']);
  });

  it('should filter out empty batches from consecutive GOs', () => {
    const sql = 'SELECT 1\nGO\nGO\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('should handle empty input', () => {
    const result = splitBatches('');
    expect(result).toEqual([]);
  });

  it('should handle whitespace-only input', () => {
    const result = splitBatches('   \n  \n  ');
    expect(result).toEqual([]);
  });

  it('should handle GO at the start', () => {
    const sql = 'GO\nSELECT 1';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1']);
  });

  it('should handle GO at the end', () => {
    const sql = 'SELECT 1\nGO';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT 1']);
  });

  it('should handle escaped quotes in strings correctly', () => {
    const sql = "SELECT 'it''s a test'\nGO\nSELECT 2";
    const result = splitBatches(sql);
    expect(result).toEqual(["SELECT 'it''s a test'", 'SELECT 2']);
  });

  it('should handle multi-line string containing GO', () => {
    const sql = "SELECT '\nGO\n' AS val\nGO\nSELECT 2";
    const result = splitBatches(sql);
    expect(result).toEqual(["SELECT '\nGO\n' AS val", 'SELECT 2']);
  });

  it('should handle block comment that starts and ends on same line', () => {
    const sql = 'SELECT /* comment */ 1\nGO\nSELECT 2';
    const result = splitBatches(sql);
    expect(result).toEqual(['SELECT /* comment */ 1', 'SELECT 2']);
  });

  it('should handle N-prefixed unicode strings', () => {
    const sql = "SELECT N'GO'\nGO\nSELECT 2";
    const result = splitBatches(sql);
    // N'GO' is a string literal on the same line, GO on next line is separator
    expect(result).toEqual(["SELECT N'GO'", 'SELECT 2']);
  });
});
