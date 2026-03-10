import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module
const mockPrepare = vi.fn();
const mockDb = { prepare: mockPrepare };

vi.mock('../../src/shared/db.js', () => ({
  getDb: () => mockDb,
  isVecEnabled: () => false,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { sqlReadonly } = await import('../../src/mcp/sql-sandbox.js');

describe('sqlReadonly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Allowed queries ──
  describe('allowed statements', () => {
    it('should allow SELECT', () => {
      mockPrepare.mockReturnValue({ all: () => [] });
      const result = sqlReadonly({ sql: 'SELECT * FROM facts' });
      expect(result).toContain('0 rows');
    });

    it('should allow WITH (CTE)', () => {
      mockPrepare.mockReturnValue({ all: () => [] });
      const result = sqlReadonly({ sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte' });
      expect(result).toContain('0 rows');
    });

    it('should allow EXPLAIN', () => {
      mockPrepare.mockReturnValue({ all: () => [] });
      const result = sqlReadonly({ sql: 'EXPLAIN SELECT 1' });
      expect(result).toContain('0 rows');
    });
  });

  // ── Denied statements ──
  describe('denied statements', () => {
    const deniedCases = [
      ['DROP', 'DROP TABLE facts'],
      ['UPDATE', 'UPDATE facts SET status = ?'],
      ['INSERT', 'INSERT INTO facts VALUES (1)'],
      ['DELETE', 'DELETE FROM facts'],
      ['ALTER', 'ALTER TABLE facts ADD col TEXT'],
      ['ATTACH', "ATTACH DATABASE '/tmp/x.db' AS ext"],
      ['PRAGMA', 'PRAGMA table_info(facts)'],
      ['CREATE', 'CREATE TABLE evil (id INT)'],
    ];

    for (const [keyword, sql] of deniedCases) {
      it(`should deny ${keyword}`, () => {
        expect(() => sqlReadonly({ sql })).toThrow();
      });
    }
  });

  // ── Deny keyword inside string literal should be allowed ──
  it('should allow deny keywords inside string literals', () => {
    mockPrepare.mockReturnValue({ all: () => [] });
    // "DROP" inside a quoted string should be stripped by the string-removal logic
    const result = sqlReadonly({ sql: "SELECT * FROM facts WHERE predicate = 'DROP this'" });
    expect(result).toContain('0 rows');
  });

  // ── SELECT-first but contains injection ──
  it('should deny SELECT with embedded DROP', () => {
    expect(() => sqlReadonly({ sql: 'SELECT 1; DROP TABLE facts' })).toThrow();
  });

  // ── Non-SELECT first word ──
  it('should reject non-allowed first word', () => {
    expect(() => sqlReadonly({ sql: 'VACUUM' })).toThrow(/Only SELECT/);
  });

  // ── Auto LIMIT ──
  it('should auto-add LIMIT when missing', () => {
    mockPrepare.mockReturnValue({ all: () => [] });
    sqlReadonly({ sql: 'SELECT * FROM facts' }, { maxRows: 50 });
    const calledSql = mockPrepare.mock.calls[0][0];
    expect(calledSql).toContain('LIMIT 50');
  });

  it('should not double-add LIMIT', () => {
    mockPrepare.mockReturnValue({ all: () => [] });
    sqlReadonly({ sql: 'SELECT * FROM facts LIMIT 10' }, { maxRows: 50 });
    const calledSql = mockPrepare.mock.calls[0][0];
    expect(calledSql).not.toContain('LIMIT 50');
    expect(calledSql).toContain('LIMIT 10');
  });

  // ── Result formatting ──
  it('should format results as markdown table', () => {
    mockPrepare.mockReturnValue({
      all: () => [
        { id: '1', name: 'test' },
        { id: '2', name: 'foo' },
      ],
    });
    const result = sqlReadonly({ sql: 'SELECT id, name FROM facts' });
    expect(result).toContain('| id | name |');
    expect(result).toContain('| 1 | test |');
    expect(result).toContain('2 rows');
  });
});
