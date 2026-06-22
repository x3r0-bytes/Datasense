import { describe, it, expect } from 'vitest';
import {
  applyTieredRanking,
  RANK_TIERS,
  AGGREGATE_FUNCTIONS,
  WINDOW_FUNCTIONS,
} from '../../server/src/completionProvider';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';

describe('applyTieredRanking — edge cases', () => {
  it('empty completion list returns empty', () => {
    const result = applyTieredRanking([], []);
    expect(result).toEqual([]);
  });

  it('no required keywords assigns tiers 1-3 only', () => {
    const items: CompletionItem[] = [
      { label: 'OrderDate', kind: CompletionItemKind.Field },
      { label: 'COUNT', kind: CompletionItemKind.Function },
      { label: 'WHERE', kind: CompletionItemKind.Keyword },
    ];

    const result = applyTieredRanking(items, []);

    // Columns → tier 1, Functions → tier 1, Keywords → tier 3 (schema objects tier)
    expect(result[0].sortText).toBe(`${RANK_TIERS.COLUMNS_AND_ALIASES}_orderdate`);
    expect(result[1].sortText).toBe(`${RANK_TIERS.COLUMNS_AND_ALIASES}_count`);
    expect(result[2].sortText).toBe(`${RANK_TIERS.SCHEMA_OBJECTS}_where`);
  });

  it('sortText format is correct ("{tier}_{lowercase_label}")', () => {
    const items: CompletionItem[] = [
      { label: 'OrderDate', kind: CompletionItemKind.Field },
      { label: 'COUNT', kind: CompletionItemKind.Function },
      { label: 'FROM', kind: CompletionItemKind.Keyword },
      { label: 'Users', kind: CompletionItemKind.Module, detail: 'Table' },
    ];

    applyTieredRanking(items, ['FROM']);

    // Column → tier 1
    expect(items[0].sortText).toBe('1_orderdate');
    // Function → tier 1
    expect(items[1].sortText).toBe('1_count');
    // Required keyword → tier 0
    expect(items[2].sortText).toBe('0_from');
    // Schema object → tier 3
    expect(items[3].sortText).toBe('3_users');
  });

  it('items within same tier are alphabetically ordered by sortText', () => {
    const items: CompletionItem[] = [
      { label: 'Zebra', kind: CompletionItemKind.Field },
      { label: 'Apple', kind: CompletionItemKind.Field },
    ];

    applyTieredRanking(items, []);

    expect(items[0].sortText).toBe('1_zebra');
    expect(items[1].sortText).toBe('1_apple');

    // Lexicographic comparison: "1_apple" < "1_zebra"
    expect(items[1].sortText! < items[0].sortText!).toBe(true);
  });

  it('CTE names get tier 2 (LOCAL_REFERENCES)', () => {
    const items: CompletionItem[] = [
      { label: 'MyCTE', kind: CompletionItemKind.Module, detail: 'CTE' },
      { label: 'Users', kind: CompletionItemKind.Module, detail: 'Table' },
    ];

    applyTieredRanking(items, []);

    expect(items[0].sortText).toBe(`${RANK_TIERS.LOCAL_REFERENCES}_mycte`);
    expect(items[1].sortText).toBe(`${RANK_TIERS.SCHEMA_OBJECTS}_users`);
  });

  it('required keywords get tier 0 (case-insensitive)', () => {
    const items: CompletionItem[] = [
      { label: 'FROM', kind: CompletionItemKind.Keyword },
      { label: 'WHERE', kind: CompletionItemKind.Keyword },
    ];

    applyTieredRanking(items, ['from']);

    // FROM matches required keyword (case-insensitive) → tier 0
    expect(items[0].sortText).toBe(`${RANK_TIERS.REQUIRED_KEYWORD}_from`);
    // WHERE is not required → tier 3
    expect(items[1].sortText).toBe(`${RANK_TIERS.SCHEMA_OBJECTS}_where`);
  });
});
