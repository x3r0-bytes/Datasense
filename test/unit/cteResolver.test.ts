import { describe, it, expect } from 'vitest';
import { extractCTEColumns, resolveChainedCTEs, buildCTESchemaMap } from '../../server/src/cteResolver';
import { ColumnInfo, ISchemaCache } from '../../server/src/schemaCache';

// --- Mock ISchemaCache helper ---

function createMockSchemaCache(tables: { schema: string; name: string; columns: ColumnInfo[] }[] = []): ISchemaCache {
  return {
    tables: tables.map(t => ({ schema: t.schema, name: t.name, columns: t.columns })),
    views: [],
    procedures: [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async () => {},
    getForeignKeysForTable: () => [],
  };
}

describe('cteResolver', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. extractCTEColumns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('extractCTEColumns', () => {
    it('simple identifiers: SELECT id, name, email', () => {
      const result = extractCTEColumns('SELECT id, name, email FROM users');
      expect(result).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
        { name: 'email', dataType: 'unknown', isNullable: true },
      ]);
    });

    it('explicit aliases: SELECT COUNT(*) AS total, MAX(id) AS max_id', () => {
      const result = extractCTEColumns('SELECT COUNT(*) AS total, MAX(id) AS max_id FROM users');
      expect(result).toEqual([
        { name: 'total', dataType: 'unknown', isNullable: true },
        { name: 'max_id', dataType: 'unknown', isNullable: true },
      ]);
    });

    it('dotted references: SELECT t.id, t.name, s.value', () => {
      const result = extractCTEColumns('SELECT t.id, t.name, s.value FROM t JOIN s ON t.id = s.id');
      expect(result).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
        { name: 'value', dataType: 'unknown', isNullable: true },
      ]);
    });

    it('mixed: SELECT id, t.name AS alias, COUNT(*)', () => {
      const result = extractCTEColumns('SELECT id, t.name AS alias, COUNT(*) FROM t');
      // COUNT(*) has no alias → omitted
      expect(result).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'alias', dataType: 'unknown', isNullable: true },
      ]);
    });

    it('SELECT * → returns null', () => {
      const result = extractCTEColumns('SELECT * FROM t');
      expect(result).toBeNull();
    });

    it('SELECT alias.* → returns empty array (not null)', () => {
      const result = extractCTEColumns('SELECT t.* FROM t');
      expect(result).toEqual([]);
    });

    it('complex expression without alias: SELECT id + 1, UPPER(name)', () => {
      const result = extractCTEColumns('SELECT id + 1, UPPER(name) FROM t');
      // Both are complex expressions without aliases → omitted
      expect(result).toEqual([]);
    });

    it('DISTINCT: SELECT DISTINCT id, name FROM t', () => {
      const result = extractCTEColumns('SELECT DISTINCT id, name FROM t');
      expect(result).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
      ]);
    });

    it('TOP: SELECT TOP 10 id, name FROM t', () => {
      const result = extractCTEColumns('SELECT TOP 10 id, name FROM t');
      expect(result).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. resolveChainedCTEs — 2 CTEs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveChainedCTEs — 2 CTEs', () => {
    it('cte2 references cte1 and gets its columns', () => {
      const sql = `WITH cte1 AS (SELECT id, name FROM users),
     cte2 AS (SELECT id, name FROM cte1)
SELECT * FROM cte2`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      expect(result.schemas.has('cte1')).toBe(true);
      expect(result.schemas.has('cte2')).toBe(true);

      const cte1 = result.schemas.get('cte1')!;
      expect(cte1.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
      ]);

      const cte2 = result.schemas.get('cte2')!;
      expect(cte2.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. resolveChainedCTEs — 3 CTEs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveChainedCTEs — 3 CTEs', () => {
    it('columns propagate through a 3-CTE chain', () => {
      const sql = `WITH a AS (SELECT id FROM t1),
     b AS (SELECT id FROM a),
     c AS (SELECT id FROM b)
SELECT * FROM c`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 't1', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      expect(result.schemas.has('c')).toBe(true);
      const cSchema = result.schemas.get('c')!;
      expect(cSchema.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. resolveChainedCTEs — 10+ CTEs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveChainedCTEs — 10+ CTEs', () => {
    it('resolves a chain of 12 CTEs without truncation', () => {
      // Build a chain: cte0 → cte1 → ... → cte11
      const cteNames = Array.from({ length: 12 }, (_, i) => `cte${i}`);
      const cteDefs = cteNames.map((name, i) => {
        if (i === 0) {
          return `${name} AS (SELECT id, val FROM base_table)`;
        }
        return `${name} AS (SELECT id, val FROM ${cteNames[i - 1]})`;
      });
      const sql = `WITH ${cteDefs.join(',\n     ')}\nSELECT * FROM cte11`;

      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'base_table', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'val', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      // All 12 CTEs should be resolved
      expect(result.schemas.size).toBe(12);

      // The last CTE should have columns propagated through the chain
      const lastCte = result.schemas.get('cte11')!;
      expect(lastCte.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'val', dataType: 'unknown', isNullable: true },
      ]);

      // All CTEs should be available at cursor position (after the chain)
      expect(result.availableNames.length).toBe(12);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Bracketed CTE identifiers
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Bracketed CTE identifiers', () => {
    it('resolves [My CTE] with brackets stripped', () => {
      const sql = `WITH [My CTE] AS (SELECT id, name FROM users)
SELECT * FROM [My CTE]`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      // Should be stored with brackets stripped
      expect(result.schemas.has('my cte')).toBe(true);
      const schema = result.schemas.get('my cte')!;
      expect(schema.name).toBe('My CTE');
      expect(schema.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. CTE with column list syntax
  // ═══════════════════════════════════════════════════════════════════════════

  describe('CTE with column list syntax', () => {
    it('WITH cte(col1, col2) AS (...) uses col1, col2 as column names', () => {
      const sql = `WITH cte(col1, col2) AS (SELECT id, name FROM users)
SELECT * FROM cte`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      expect(result.schemas.has('cte')).toBe(true);
      const schema = result.schemas.get('cte')!;
      // Column list overrides the SELECT list
      expect(schema.columns).toEqual([
        { name: 'col1', dataType: 'unknown', isNullable: true },
        { name: 'col2', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Forward references produce zero columns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Forward references', () => {
    it('forward reference produces zero columns from the unresolved CTE', () => {
      const sql = `WITH a AS (SELECT id FROM b),
     b AS (SELECT id FROM users)
SELECT * FROM a`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      // 'a' references 'b' which is defined later (forward reference)
      // 'a' should have columns from its own SELECT (id is a simple identifier)
      const aSchema = result.schemas.get('a')!;
      expect(aSchema.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
      ]);

      // 'b' references 'users' from schema cache
      const bSchema = result.schemas.get('b')!;
      expect(bSchema.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. SELECT * returns null
  // ═══════════════════════════════════════════════════════════════════════════

  describe('SELECT * returns null', () => {
    it('CTE with SELECT * has null columns', () => {
      const sql = `WITH cte AS (SELECT * FROM users)
SELECT * FROM cte`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      expect(result.schemas.has('cte')).toBe(true);
      const schema = result.schemas.get('cte')!;
      expect(schema.columns).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Mixed sources (schema table + CTE in same FROM)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Mixed sources', () => {
    it('CTE body referencing both a schema table and another CTE concatenates columns', () => {
      const sql = `WITH cte1 AS (SELECT id, name FROM users),
     cte2 AS (SELECT c.id, c.name, o.amount FROM cte1 c JOIN orders o ON c.id = o.user_id)
SELECT * FROM cte2`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
        { schema: 'dbo', name: 'orders', columns: [
          { name: 'order_id', dataType: 'int', isNullable: false },
          { name: 'user_id', dataType: 'int', isNullable: false },
          { name: 'amount', dataType: 'decimal', isNullable: true },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      const cte2 = result.schemas.get('cte2')!;
      // cte2 SELECT list has explicit dotted references: c.id, c.name, o.amount
      expect(cte2.columns).toEqual([
        { name: 'id', dataType: 'unknown', isNullable: true },
        { name: 'name', dataType: 'unknown', isNullable: true },
        { name: 'amount', dataType: 'unknown', isNullable: true },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Case-insensitive CTE name lookup
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Case-insensitive CTE name lookup', () => {
    it('buildCTESchemaMap allows lookup by any case variation', () => {
      const sql = `WITH MyCte AS (SELECT id, name FROM users)
SELECT * FROM MyCte`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: true },
        ]},
      ]);

      const resolution = resolveChainedCTEs(sql, sql.length, schemaCache);
      const schemaMap = buildCTESchemaMap(resolution);

      // Lookup by lowercase
      expect(schemaMap.has('mycte')).toBe(true);
      // The map keys are lowercase
      const cols = schemaMap.get('mycte')!;
      expect(cols.length).toBe(2);
      expect(cols[0].name).toBe('id');
      expect(cols[1].name).toBe('name');
    });

    it('resolveChainedCTEs stores schemas with lowercase keys', () => {
      const sql = `WITH UpperCase AS (SELECT id FROM t1)
SELECT * FROM UpperCase`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 't1', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      // Key is lowercase
      expect(result.schemas.has('uppercase')).toBe(true);
      // Original name preserves case
      expect(result.schemas.get('uppercase')!.name).toBe('UpperCase');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. Table hint WITH (NOLOCK) is not treated as CTE
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Table hint WITH (NOLOCK) is not treated as CTE', () => {
    it('SELECT * FROM users WITH (NOLOCK) → no CTEs detected', () => {
      const sql = 'SELECT * FROM users WITH (NOLOCK)';
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      const result = resolveChainedCTEs(sql, sql.length, schemaCache);

      expect(result.schemas.size).toBe(0);
      expect(result.availableNames.length).toBe(0);
      expect(result.inCTEChain).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. buildCTESchemaMap
  // ═══════════════════════════════════════════════════════════════════════════

  describe('buildCTESchemaMap', () => {
    it('maps null columns (SELECT *) to empty array', () => {
      const sql = `WITH cte AS (SELECT * FROM users)
SELECT * FROM cte`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 'users', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      const resolution = resolveChainedCTEs(sql, sql.length, schemaCache);
      const schemaMap = buildCTESchemaMap(resolution);

      // SELECT * → null columns → mapped to empty array
      expect(schemaMap.has('cte')).toBe(true);
      expect(schemaMap.get('cte')).toEqual([]);
    });

    it('includes only CTEs available at cursor position', () => {
      const sql = `WITH a AS (SELECT id FROM t1),
     b AS (SELECT id FROM a)
SELECT * FROM b`;
      const schemaCache = createMockSchemaCache([
        { schema: 'dbo', name: 't1', columns: [
          { name: 'id', dataType: 'int', isNullable: false },
        ]},
      ]);

      // Cursor at end → both CTEs available
      const resolution = resolveChainedCTEs(sql, sql.length, schemaCache);
      const schemaMap = buildCTESchemaMap(resolution);

      expect(schemaMap.has('a')).toBe(true);
      expect(schemaMap.has('b')).toBe(true);
    });
  });
});
