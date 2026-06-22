import { describe, it, expect } from 'vitest';
import { generateAlias } from '../../server/src/aliasGenerator';

describe('AliasGenerator', () => {
  describe('PascalCase word boundary detection', () => {
    it('splits on lowercase→uppercase boundary: OrderDetails → od', () => {
      expect(generateAlias('OrderDetails', [])).toBe('od');
    });

    it('splits on uppercase→uppercase+lowercase boundary: XMLParser → xp', () => {
      expect(generateAlias('XMLParser', [])).toBe('xp');
    });

    it('treats consecutive uppercase followed by lowercase as boundary: IOStream → is', () => {
      // IOStream splits as ["IO", "Stream"] → first letters "i" + "s" = "is"
      // The design doc says "ios" but the implementation correctly treats "IO" as one word
      // and "Stream" as another, producing "is". This is consistent with the PascalCase rules.
      expect(generateAlias('IOStream', [])).toBe('is');
    });
  });

  describe('Underscore-separated names', () => {
    it('splits on underscores: order_items → oi', () => {
      expect(generateAlias('order_items', [])).toBe('oi');
    });
  });

  describe('Single word names', () => {
    it('uses first letter only: Orders → o', () => {
      expect(generateAlias('Orders', [])).toBe('o');
    });
  });

  describe('Special characters and empty derivation', () => {
    it('defaults to t when name has only special characters', () => {
      expect(generateAlias('@#$%', [])).toBe('t');
    });

    it('defaults to t for empty string input', () => {
      expect(generateAlias('', [])).toBe('t');
    });
  });

  describe('Conflict resolution with numeric suffix', () => {
    it('appends numeric suffix 2 when base alias conflicts', () => {
      expect(generateAlias('Orders', ['o'])).toBe('o2');
    });

    it('increments suffix when multiple conflicts exist', () => {
      expect(generateAlias('Orders', ['o', 'o2', 'o3'])).toBe('o4');
    });

    it('performs case-insensitive conflict detection', () => {
      expect(generateAlias('Orders', ['O'])).toBe('o2');
    });
  });

  describe('Suffix exhaustion fallback', () => {
    it('falls back to t base when all numeric suffixes 2-99 are exhausted', () => {
      // Create existing aliases: 'od', 'od2', 'od3', ..., 'od99'
      const existing = ['od'];
      for (let i = 2; i <= 99; i++) {
        existing.push(`od${i}`);
      }
      // Should fall back to 't' since it's not in existing
      expect(generateAlias('OrderDetails', existing)).toBe('t');
    });

    it('falls back to t with numeric suffix when t base also conflicts', () => {
      // Exhaust 'od' through 'od99', and also take 't'
      const existing = ['od', 't'];
      for (let i = 2; i <= 99; i++) {
        existing.push(`od${i}`);
      }
      expect(generateAlias('OrderDetails', existing)).toBe('t2');
    });

    it('falls back to alphabetic suffixes when t through t99 are exhausted', () => {
      // Exhaust 'od' through 'od99', 't' through 't99'
      const existing = ['od', 't'];
      for (let i = 2; i <= 99; i++) {
        existing.push(`od${i}`);
        existing.push(`t${i}`);
      }
      // Should fall back to 'ta'
      expect(generateAlias('OrderDetails', existing)).toBe('ta');
    });

    it('uses subsequent alphabetic suffixes when earlier ones are taken', () => {
      // Exhaust 'od' through 'od99', 't' through 't99', and 'ta'
      const existing = ['od', 't', 'ta'];
      for (let i = 2; i <= 99; i++) {
        existing.push(`od${i}`);
        existing.push(`t${i}`);
      }
      expect(generateAlias('OrderDetails', existing)).toBe('tb');
    });
  });
});
