/**
 * T-SQL Parser — Recursive-descent parser for T-SQL syntax.
 * Produces an AST with accurate source ranges for each construct.
 * Used by both the linter and formatter modules.
 */

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** A position in the source document */
export interface SourcePosition {
  line: number;    // 0-based line number
  column: number;  // 0-based column offset
}

/** A range in the source document */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/** A syntax error detected during parsing */
export interface SyntaxError {
  message: string;
  range: SourceRange;
}

/** Result of parsing a single batch */
export interface ParseResult {
  ast: TSqlNode | null;   // null if parsing failed entirely
  errors: SyntaxError[];
}

/** Base AST node type */
export interface TSqlNode {
  type: TSqlNodeType;
  range: SourceRange;
  children?: TSqlNode[];
  /** Raw text content for leaf nodes (identifiers, literals, keywords, etc.) */
  text?: string;
}

export type TSqlNodeType =
  | 'batch'
  | 'selectStatement'
  | 'insertStatement'
  | 'updateStatement'
  | 'deleteStatement'
  | 'createStatement'
  | 'alterStatement'
  | 'dropStatement'
  | 'execStatement'
  | 'declareStatement'
  | 'setStatement'
  | 'ifStatement'
  | 'whileStatement'
  | 'beginEndBlock'
  | 'tryCatchBlock'
  | 'mergeStatement'
  | 'cteDefinition'
  | 'selectClause'
  | 'fromClause'
  | 'whereClause'
  | 'joinClause'
  | 'groupByClause'
  | 'havingClause'
  | 'orderByClause'
  | 'columnExpression'
  | 'tableReference'
  | 'subquery'
  | 'caseExpression'
  | 'functionCall'
  | 'identifier'
  | 'literal'
  | 'operator'
  | 'keyword'
  | 'comment'
  | 'unknown';

// ─── Token Types ──────────────────────────────────────────────────────────────

interface Token {
  type: TokenType;
  value: string;
  range: SourceRange;
}

type TokenType =
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'operator'
  | 'punctuation'
  | 'comment'
  | 'whitespace'
  | 'eof';

// ─── T-SQL Keywords ───────────────────────────────────────────────────────────

const TSQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'IS', 'NULL', 'AS', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'PROCEDURE', 'PROC',
  'FUNCTION', 'TRIGGER', 'INDEX', 'SCHEMA', 'DATABASE', 'EXEC', 'EXECUTE',
  'DECLARE', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'TRY', 'CATCH',
  'THROW', 'RETURN', 'BREAK', 'CONTINUE', 'GOTO', 'PRINT', 'RAISERROR',
  'WITH', 'NOLOCK', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'ORDER', 'BY',
  'GROUP', 'HAVING', 'TOP', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'CAST', 'CONVERT', 'COALESCE', 'NULLIF', 'IIF', 'MERGE',
  'USING', 'MATCHED', 'TARGET', 'SOURCE', 'OUTPUT', 'INSERTED', 'DELETED',
  'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE',
  'ASC', 'DESC', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'FIRST',
  'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE',
  'CHECK', 'DEFAULT', 'IDENTITY', 'CLUSTERED', 'NONCLUSTERED',
  'GO', 'USE', 'GRANT', 'REVOKE', 'DENY', 'ROLLBACK', 'COMMIT',
  'TRANSACTION', 'TRAN', 'SAVE', 'SAVEPOINT', 'WAITFOR', 'DELAY',
  'OPENQUERY', 'OPENROWSET', 'PIVOT', 'UNPIVOT', 'APPLY',
  'OPTION', 'RECOMPILE', 'MAXRECURSION', 'CURSOR', 'OPEN', 'CLOSE',
  'DEALLOCATE', 'FETCH', 'ABSOLUTE', 'RELATIVE', 'PRIOR',
  'VARCHAR', 'NVARCHAR', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'BIT', 'DATE', 'DATETIME',
  'DATETIME2', 'TIME', 'CHAR', 'NCHAR', 'TEXT', 'NTEXT', 'IMAGE',
  'BINARY', 'VARBINARY', 'UNIQUEIDENTIFIER', 'XML', 'MONEY', 'SMALLMONEY',
  'SMALLDATETIME', 'DATETIMEOFFSET', 'HIERARCHYID', 'GEOGRAPHY', 'GEOMETRY',
  'MAX', 'MIN', 'COUNT', 'SUM', 'AVG', 'STDEV', 'VAR',
  'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT', 'LOG', 'EXP',
  'SIGN', 'RAND', 'NEWID', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME',
  'DATEADD', 'DATEDIFF', 'DATENAME', 'DATEPART', 'YEAR', 'MONTH', 'DAY',
  'LEN', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'REPLACE',
  'SUBSTRING', 'CHARINDEX', 'PATINDEX', 'STUFF', 'REVERSE', 'REPLICATE',
  'SPACE', 'STR', 'LEFT', 'RIGHT', 'FORMAT', 'CONCAT', 'STRING_AGG',
  'ISNULL', 'SCOPE_IDENTITY', 'IDENT_CURRENT', 'OBJECT_ID',
  'OBJECT_DEFINITION', 'DB_NAME', 'SCHEMA_NAME', 'TYPE_NAME',
  'COLUMNPROPERTY', 'SERVERPROPERTY', 'DATABASEPROPERTYEX',
  'TEMP', 'GLOBAL', 'LOCAL', 'STATIC', 'DYNAMIC', 'FAST_FORWARD',
  'READ_ONLY', 'SCROLL', 'KEYSET', 'OPTIMISTIC', 'TYPE',
  'READONLY', 'OUTPUT', 'VARYING', 'RETURNS', 'EXTERNAL', 'NAME',
  'NONCLUSTERED', 'INCLUDE', 'FILLFACTOR', 'PAD_INDEX', 'STATISTICS_NORECOMPUTE',
  'ALLOW_ROW_LOCKS', 'ALLOW_PAGE_LOCKS', 'ONLINE', 'SORT_IN_TEMPDB',
  'NOCOUNT', 'ANSI_NULLS', 'QUOTED_IDENTIFIER', 'XACT_ABORT',
]);

// ─── Lexer ────────────────────────────────────────────────────────────────────

class Lexer {
  private text: string;
  private pos: number = 0;
  private line: number = 0;
  private column: number = 0;
  private tokens: Token[] = [];
  private tokenIndex: number = 0;
  /** Tracks the offset at which each token starts, used for substring extraction */
  private startOffset: number = 0;

  constructor(text: string) {
    this.text = text;
    this.tokenize();
  }

  private tokenize(): void {
    while (this.pos < this.text.length) {
      this.startOffset = this.pos;
      const start = this.getPosition();
      const ch = this.text[this.pos];

      // Whitespace
      if (/\s/.test(ch)) {
        this.consumeWhitespace(start);
        continue;
      }

      // Single-line comment
      if (ch === '-' && this.peek(1) === '-') {
        this.consumeLineComment(start);
        continue;
      }

      // Block comment
      if (ch === '/' && this.peek(1) === '*') {
        this.consumeBlockComment(start);
        continue;
      }

      // String literal (single-quoted)
      if (ch === "'") {
        this.consumeStringLiteral(start);
        continue;
      }

      // N-prefixed string literal
      if ((ch === 'N' || ch === 'n') && this.peek(1) === "'") {
        this.consumeNStringLiteral(start);
        continue;
      }

      // Quoted identifier [...]
      if (ch === '[') {
        this.consumeBracketIdentifier(start);
        continue;
      }

      // Quoted identifier "..."
      if (ch === '"') {
        this.consumeDoubleQuoteIdentifier(start);
        continue;
      }

      // Number
      if (/\d/.test(ch)) {
        this.consumeNumber(start);
        continue;
      }

      // Operators and punctuation
      if (this.isOperatorChar(ch)) {
        this.consumeOperator(start);
        continue;
      }

      // Punctuation
      if ('(),.;'.includes(ch)) {
        this.advance();
        this.tokens.push({
          type: 'punctuation',
          value: ch,
          range: { start, end: this.getPosition() },
        });
        continue;
      }

      // Identifier or keyword (including @variables, #temp tables, @@globals)
      if (this.isIdentStart(ch)) {
        this.consumeIdentifierOrKeyword(start);
        continue;
      }

      // Unknown character — advance past it
      this.advance();
      this.tokens.push({
        type: 'punctuation',
        value: ch,
        range: { start, end: this.getPosition() },
      });
    }

    // EOF token
    const eofPos = this.getPosition();
    this.tokens.push({
      type: 'eof',
      value: '',
      range: { start: eofPos, end: eofPos },
    });
  }

  private getPosition(): SourcePosition {
    return { line: this.line, column: this.column };
  }

  private peek(offset: number): string {
    const idx = this.pos + offset;
    return idx < this.text.length ? this.text[idx] : '';
  }

  private advance(): void {
    if (this.text[this.pos] === '\n') {
      this.line++;
      this.column = 0;
    } else {
      this.column++;
    }
    this.pos++;
  }

  private isIdentStart(ch: string): boolean {
    return /[a-zA-Z_@#]/.test(ch);
  }

  private isIdentChar(ch: string): boolean {
    return /[a-zA-Z0-9_@#$]/.test(ch);
  }

  private isOperatorChar(ch: string): boolean {
    return '=<>!+-*/%&|^~'.includes(ch);
  }

  private consumeWhitespace(start: SourcePosition): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
      this.advance();
    }
    // We skip whitespace tokens — they're not needed for parsing
  }

  private consumeLineComment(start: SourcePosition): void {
    const tokenStart = this.startOffset;
    // Skip --
    this.advance();
    this.advance();
    while (this.pos < this.text.length && this.text[this.pos] !== '\n') {
      this.advance();
    }
    this.tokens.push({
      type: 'comment',
      value: this.text.substring(tokenStart, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeBlockComment(start: SourcePosition): void {
    const tokenStart = this.startOffset;
    // Skip /*
    this.advance();
    this.advance();
    while (this.pos < this.text.length) {
      if (this.text[this.pos] === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        break;
      }
      this.advance();
    }
    this.tokens.push({
      type: 'comment',
      value: this.text.substring(tokenStart, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeStringLiteral(start: SourcePosition): void {
    this.advance(); // skip opening quote
    while (this.pos < this.text.length) {
      if (this.text[this.pos] === "'") {
        this.advance();
        // Escaped quote ''
        if (this.pos < this.text.length && this.text[this.pos] === "'") {
          this.advance();
        } else {
          break;
        }
      } else {
        this.advance();
      }
    }
    this.tokens.push({
      type: 'string',
      value: this.text.substring(this.startOffset, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeNStringLiteral(start: SourcePosition): void {
    this.advance(); // skip N — startOffset already set to include N
    // Now consume the string literal portion
    this.advance(); // skip opening quote
    while (this.pos < this.text.length) {
      if (this.text[this.pos] === "'") {
        this.advance();
        if (this.pos < this.text.length && this.text[this.pos] === "'") {
          this.advance();
        } else {
          break;
        }
      } else {
        this.advance();
      }
    }
    this.tokens.push({
      type: 'string',
      value: this.text.substring(this.startOffset, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeBracketIdentifier(start: SourcePosition): void {
    this.advance(); // skip [
    while (this.pos < this.text.length && this.text[this.pos] !== ']') {
      this.advance();
    }
    if (this.pos < this.text.length) {
      this.advance(); // skip ]
    }
    this.tokens.push({
      type: 'identifier',
      value: this.text.substring(this.startOffset, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeDoubleQuoteIdentifier(start: SourcePosition): void {
    this.advance(); // skip opening "
    while (this.pos < this.text.length && this.text[this.pos] !== '"') {
      this.advance();
    }
    if (this.pos < this.text.length) {
      this.advance(); // skip closing "
    }
    this.tokens.push({
      type: 'identifier',
      value: this.text.substring(this.startOffset, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeNumber(start: SourcePosition): void {
    while (this.pos < this.text.length && /\d/.test(this.text[this.pos])) {
      this.advance();
    }
    // Decimal part
    if (this.pos < this.text.length && this.text[this.pos] === '.') {
      this.advance();
      while (this.pos < this.text.length && /\d/.test(this.text[this.pos])) {
        this.advance();
      }
    }
    this.tokens.push({
      type: 'number',
      value: this.text.substring(this.startOffset, this.pos),
      range: { start, end: this.getPosition() },
    });
  }

  private consumeOperator(start: SourcePosition): void {
    const ch = this.text[this.pos];
    this.advance();
    // Two-character operators
    if (this.pos < this.text.length) {
      const next = this.text[this.pos];
      const twoChar = ch + next;
      if (['<=', '>=', '<>', '!=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(twoChar)) {
        this.advance();
        this.tokens.push({
          type: 'operator',
          value: twoChar,
          range: { start, end: this.getPosition() },
        });
        return;
      }
    }
    this.tokens.push({
      type: 'operator',
      value: ch,
      range: { start, end: this.getPosition() },
    });
  }

  private consumeIdentifierOrKeyword(start: SourcePosition): void {
    while (this.pos < this.text.length && this.isIdentChar(this.text[this.pos])) {
      this.advance();
    }
    const value = this.text.substring(this.startOffset, this.pos);
    const upper = value.toUpperCase();
    const isKeyword = TSQL_KEYWORDS.has(upper) && !value.startsWith('@') && !value.startsWith('#');
    this.tokens.push({
      type: isKeyword ? 'keyword' : 'identifier',
      value,
      range: { start, end: this.getPosition() },
    });
  }

  // ─── Public Token Access ──────────────────────────────────────────────────

  /** Get the current token without advancing */
  current(): Token {
    return this.tokens[this.tokenIndex] || this.tokens[this.tokens.length - 1];
  }

  /** Advance to the next non-comment token and return the previous one */
  next(): Token {
    const token = this.tokens[this.tokenIndex];
    this.tokenIndex++;
    // Skip comments
    while (this.tokenIndex < this.tokens.length && this.tokens[this.tokenIndex].type === 'comment') {
      this.tokenIndex++;
    }
    return token;
  }

  /** Peek at the next non-comment token without advancing */
  peekToken(offset: number = 0): Token {
    let idx = this.tokenIndex;
    let skipped = 0;
    while (idx < this.tokens.length && skipped <= offset) {
      if (idx !== this.tokenIndex && this.tokens[idx].type === 'comment') {
        idx++;
        continue;
      }
      if (skipped === offset) {
        return this.tokens[idx];
      }
      skipped++;
      idx++;
    }
    return this.tokens[this.tokens.length - 1];
  }

  /** Check if current token matches a keyword (case-insensitive) */
  isKeyword(...keywords: string[]): boolean {
    const token = this.current();
    if (token.type !== 'keyword') return false;
    return keywords.some(k => token.value.toUpperCase() === k.toUpperCase());
  }

  /** Check if current token is a specific punctuation */
  isPunctuation(value: string): boolean {
    const token = this.current();
    return token.type === 'punctuation' && token.value === value;
  }

  /** Check if we've reached end of file */
  isEof(): boolean {
    return this.current().type === 'eof';
  }

  /** Get all comment tokens (for preserving in AST) */
  getComments(): Token[] {
    return this.tokens.filter(t => t.type === 'comment');
  }
}


// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private lexer: Lexer;
  private errors: SyntaxError[] = [];

  constructor(text: string) {
    this.lexer = new Lexer(text);
    // Skip initial comments
    while (this.lexer.current().type === 'comment') {
      (this.lexer as any).tokenIndex++;
    }
  }

  parse(): ParseResult {
    try {
      const statements: TSqlNode[] = [];
      const start = this.lexer.current().range.start;

      while (!this.lexer.isEof()) {
        // Skip semicolons between statements
        while (this.lexer.isPunctuation(';')) {
          this.lexer.next();
        }
        if (this.lexer.isEof()) break;

        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
      }

      if (statements.length === 0) {
        return { ast: null, errors: this.errors };
      }

      const end = statements[statements.length - 1].range.end;
      const batch: TSqlNode = {
        type: 'batch',
        range: { start, end },
        children: statements,
      };

      return { ast: batch, errors: this.errors };
    } catch (e) {
      // Internal parser failure — return what we have
      return { ast: null, errors: this.errors };
    }
  }

  private parseStatement(): TSqlNode | null {
    const token = this.lexer.current();

    if (token.type === 'keyword') {
      const kw = token.value.toUpperCase();

      switch (kw) {
        case 'SELECT':
          return this.parseSelectStatement();
        case 'INSERT':
          return this.parseInsertStatement();
        case 'UPDATE':
          return this.parseUpdateStatement();
        case 'DELETE':
          return this.parseDeleteStatement();
        case 'CREATE':
          return this.parseCreateStatement();
        case 'ALTER':
          return this.parseAlterStatement();
        case 'DROP':
          return this.parseDropStatement();
        case 'EXEC':
        case 'EXECUTE':
          return this.parseExecStatement();
        case 'DECLARE':
          return this.parseDeclareStatement();
        case 'SET':
          return this.parseSetStatement();
        case 'IF':
          return this.parseIfStatement();
        case 'WHILE':
          return this.parseWhileStatement();
        case 'BEGIN':
          return this.parseBeginBlock();
        case 'MERGE':
          return this.parseMergeStatement();
        case 'WITH':
          return this.parseWithCte();
        case 'RETURN':
        case 'PRINT':
        case 'RAISERROR':
        case 'THROW':
          return this.parseSimpleStatement();
        case 'USE':
        case 'GRANT':
        case 'REVOKE':
        case 'DENY':
          return this.parseSimpleStatement();
        case 'WAITFOR':
          return this.parseSimpleStatement();
        case 'BREAK':
        case 'CONTINUE':
        case 'GOTO':
          return this.parseSimpleStatement();
        default:
          return this.parseUnknownStatement();
      }
    }

    // Handle labels (identifier followed by colon)
    // or unknown statements
    return this.parseUnknownStatement();
  }

  // ─── SELECT Statement ─────────────────────────────────────────────────────

  private parseSelectStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    const children: TSqlNode[] = [];

    // SELECT clause
    children.push(this.parseSelectClause());

    // Optional INTO (SELECT INTO #temp / @var)
    if (this.lexer.isKeyword('INTO')) {
      this.lexer.next(); // consume INTO
      // Consume the target table/variable name (possibly schema-qualified)
      while (!this.lexer.isEof() && (this.lexer.current().type === 'identifier' ||
             this.lexer.current().type === 'keyword') && !this.isClauseKeyword()) {
        this.lexer.next();
        if (this.lexer.isPunctuation('.')) {
          this.lexer.next();
        } else {
          break;
        }
      }
    }

    // FROM clause
    if (this.lexer.isKeyword('FROM')) {
      children.push(this.parseFromClause());
    }

    // WHERE clause
    if (this.lexer.isKeyword('WHERE')) {
      children.push(this.parseWhereClause());
    }

    // GROUP BY clause
    if (this.lexer.isKeyword('GROUP')) {
      children.push(this.parseGroupByClause());
    }

    // HAVING clause
    if (this.lexer.isKeyword('HAVING')) {
      children.push(this.parseHavingClause());
    }

    // ORDER BY clause
    if (this.lexer.isKeyword('ORDER')) {
      children.push(this.parseOrderByClause());
    }

    // UNION / EXCEPT / INTERSECT
    if (this.lexer.isKeyword('UNION', 'EXCEPT', 'INTERSECT')) {
      this.lexer.next();
      if (this.lexer.isKeyword('ALL')) {
        this.lexer.next();
      }
      const nextSelect = this.parseSelectStatement();
      children.push(nextSelect);
    }

    // OPTION clause
    if (this.lexer.isKeyword('OPTION')) {
      this.consumeParenthesized();
    }

    const end = this.getLastEnd(children, start);
    return { type: 'selectStatement', range: { start, end }, children };
  }

  private parseSelectClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume SELECT

    // Optional DISTINCT / TOP
    if (this.lexer.isKeyword('DISTINCT')) {
      this.lexer.next();
    }
    if (this.lexer.isKeyword('TOP')) {
      this.lexer.next();
      if (this.lexer.isPunctuation('(')) {
        this.consumeParenthesized();
      } else {
        // TOP N
        this.lexer.next();
      }
    }

    // Parse column list
    const columns: TSqlNode[] = [];
    while (!this.lexer.isEof() && !this.isSelectClauseEnd()) {
      const col = this.parseColumnExpression();
      if (col) columns.push(col);
      if (this.lexer.isPunctuation(',')) {
        this.lexer.next();
      } else {
        break;
      }
    }

    // Error: SELECT with no column list (e.g., "SELECT FROM ...")
    if (columns.length === 0 && !this.lexer.isEof()) {
      const errorEnd = this.lexer.current().range.start;
      this.addError(
        `Incorrect syntax near '${this.lexer.current().value}'. Expected column list after SELECT.`,
        { start, end: errorEnd }
      );
    }

    const end = this.getLastEnd(columns, start);
    return { type: 'selectClause', range: { start, end }, children: columns };
  }

  private isSelectClauseEnd(): boolean {
    if (this.lexer.isKeyword('FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING',
      'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION')) {
      return true;
    }
    // Also stop at block-terminating and statement-starting keywords
    if (this.lexer.isKeyword('END', 'ELSE', 'BEGIN', 'WHEN', 'THEN')) {
      return true;
    }
    return this.isStatementStart();
  }

  private parseColumnExpression(): TSqlNode | null {
    const start = this.lexer.current().range.start;
    // Consume tokens until comma or clause boundary
    let depth = 0;
    const exprStart = start;

    while (!this.lexer.isEof()) {
      if (depth === 0 && (this.lexer.isPunctuation(',') || this.isSelectClauseEnd())) {
        break;
      }
      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) depth--;
      this.lexer.next();
    }

    const end = this.lexer.current().range.start;
    return { type: 'columnExpression', range: { start: exprStart, end } };
  }

  // ─── FROM Clause ──────────────────────────────────────────────────────────

  private parseFromClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume FROM
    const children: TSqlNode[] = [];

    // Check if FROM is immediately followed by a clause keyword or EOF (no table reference)
    if (this.lexer.isEof() || this.isClauseKeyword() || this.isStatementStart()) {
      const errorEnd = this.lexer.isEof() ? start : this.lexer.current().range.start;
      this.addError(
        `Incorrect syntax near 'FROM'. Expected table or view name.`,
        { start, end: errorEnd }
      );
    } else {
      // Parse table references
      const tableRef = this.parseTableReference();
      if (tableRef) children.push(tableRef);

      // Additional comma-separated table references
      while (this.lexer.isPunctuation(',')) {
        this.lexer.next();
        const ref = this.parseTableReference();
        if (ref) children.push(ref);
      }
    }

    // JOIN clauses
    while (this.isJoinKeyword()) {
      children.push(this.parseJoinClause());
    }

    // PIVOT / UNPIVOT / APPLY
    while (this.lexer.isKeyword('PIVOT', 'UNPIVOT', 'CROSS', 'OUTER')) {
      if (this.lexer.isKeyword('CROSS', 'OUTER')) {
        const next = this.lexer.peekToken(1);
        if (next.value.toUpperCase() === 'APPLY') {
          this.lexer.next(); // CROSS/OUTER
          this.lexer.next(); // APPLY
          this.parseTableReference();
        } else {
          break;
        }
      } else {
        this.lexer.next(); // PIVOT/UNPIVOT
        if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        }
        // Optional alias
        if (this.lexer.isKeyword('AS')) this.lexer.next();
        if (this.lexer.current().type === 'identifier' || this.lexer.current().type === 'keyword') {
          this.lexer.next();
        }
      }
    }

    const end = this.getLastEnd(children, start);
    return { type: 'fromClause', range: { start, end }, children };
  }

  private parseTableReference(): TSqlNode | null {
    const start = this.lexer.current().range.start;

    // Subquery as table source
    if (this.lexer.isPunctuation('(')) {
      const subquery = this.parseSubquery();
      // Optional alias after subquery
      if (this.lexer.isKeyword('AS')) this.lexer.next();
      if (!this.lexer.isEof() && (this.lexer.current().type === 'identifier' ||
          (this.lexer.current().type === 'keyword' && !this.isClauseKeyword()))) {
        this.lexer.next();
      }
      return subquery;
    }

    // Table name (possibly schema-qualified: schema.table or db.schema.table)
    if (this.lexer.current().type === 'identifier' || this.lexer.current().type === 'keyword') {
      this.lexer.next();
      // Dot-separated parts
      while (this.lexer.isPunctuation('.') && !this.lexer.isEof()) {
        this.lexer.next(); // dot
        if (this.lexer.current().type === 'identifier' || this.lexer.current().type === 'keyword') {
          this.lexer.next();
        }
      }

      // Table hint WITH (NOLOCK)
      if (this.lexer.isKeyword('WITH') && !this.isWithCteContext()) {
        this.lexer.next();
        if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        }
      }

      // Optional alias
      if (this.lexer.isKeyword('AS')) this.lexer.next();
      if (!this.lexer.isEof() && this.lexer.current().type === 'identifier' &&
          !this.isClauseKeyword()) {
        this.lexer.next();
      } else if (!this.lexer.isEof() && this.lexer.current().type === 'keyword' &&
          !this.isClauseKeyword() && !this.isJoinKeyword() &&
          !this.lexer.isKeyword('ON', 'WHERE', 'SET', 'VALUES', 'OUTPUT', 'WITH',
            'USING', 'WHEN', 'MATCHED', 'THEN', 'BEGIN', 'END', 'ELSE',
            'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'GO',
            'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'CREATE', 'ALTER', 'DROP',
            'EXEC', 'EXECUTE', 'DECLARE', 'IF', 'WHILE', 'MERGE', 'RETURN',
            'PRINT', 'RAISERROR', 'THROW', 'BREAK', 'CONTINUE', 'GOTO')) {
        this.lexer.next();
      }
    }

    const end = this.lexer.current().range.start;
    return { type: 'tableReference', range: { start, end } };
  }

  private isJoinKeyword(): boolean {
    const token = this.lexer.current();
    if (token.type !== 'keyword') return false;
    const kw = token.value.toUpperCase();
    if (kw === 'JOIN') return true;
    if (['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'].includes(kw)) {
      const next = this.lexer.peekToken(1);
      return next.value.toUpperCase() === 'JOIN' ||
             next.value.toUpperCase() === 'OUTER' ||
             next.value.toUpperCase() === 'APPLY';
    }
    return false;
  }

  private parseJoinClause(): TSqlNode {
    const start = this.lexer.current().range.start;

    // Consume join type keywords (INNER, LEFT, RIGHT, FULL, OUTER, CROSS)
    while (this.lexer.isKeyword('INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN')) {
      this.lexer.next();
      if (this.lexer.current().range.start === start) break; // safety
    }

    // Parse table reference
    this.parseTableReference();

    // ON clause
    if (this.lexer.isKeyword('ON')) {
      this.lexer.next();
      this.parseExpression();
    }

    const end = this.lexer.current().range.start;
    return { type: 'joinClause', range: { start, end } };
  }

  // ─── WHERE Clause ─────────────────────────────────────────────────────────

  private parseWhereClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume WHERE
    this.parseExpression();
    const end = this.lexer.current().range.start;
    return { type: 'whereClause', range: { start, end } };
  }

  // ─── GROUP BY Clause ──────────────────────────────────────────────────────

  private parseGroupByClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume GROUP
    if (this.lexer.isKeyword('BY')) this.lexer.next(); // consume BY
    this.parseExpressionList();
    const end = this.lexer.current().range.start;
    return { type: 'groupByClause', range: { start, end } };
  }

  // ─── HAVING Clause ────────────────────────────────────────────────────────

  private parseHavingClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume HAVING
    this.parseExpression();
    const end = this.lexer.current().range.start;
    return { type: 'havingClause', range: { start, end } };
  }

  // ─── ORDER BY Clause ──────────────────────────────────────────────────────

  private parseOrderByClause(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume ORDER
    if (this.lexer.isKeyword('BY')) this.lexer.next(); // consume BY
    this.parseExpressionList();
    // OFFSET ... FETCH
    if (this.lexer.isKeyword('OFFSET')) {
      this.lexer.next();
      this.parseExpression();
      if (this.lexer.isKeyword('ROWS', 'ROW')) this.lexer.next();
      if (this.lexer.isKeyword('FETCH')) {
        this.lexer.next();
        if (this.lexer.isKeyword('NEXT', 'FIRST')) this.lexer.next();
        this.parseExpression();
        if (this.lexer.isKeyword('ROWS', 'ROW')) this.lexer.next();
        if (this.lexer.isKeyword('ONLY')) this.lexer.next();
      }
    }
    const end = this.lexer.current().range.start;
    return { type: 'orderByClause', range: { start, end } };
  }

  // ─── INSERT Statement ─────────────────────────────────────────────────────

  private parseInsertStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume INSERT

    if (this.lexer.isKeyword('INTO')) this.lexer.next();

    // Table name — check if missing
    if (this.lexer.isEof() || this.lexer.isPunctuation(';') || this.isStatementStart()) {
      const errorEnd = this.lexer.isEof() ? start : this.lexer.current().range.start;
      this.addError(
        `Incorrect syntax near 'INSERT'. Expected table name.`,
        { start, end: errorEnd }
      );
      return { type: 'insertStatement', range: { start, end: errorEnd } };
    }

    this.parseTableReference();

    // Optional column list
    if (this.lexer.isPunctuation('(')) {
      this.consumeParenthesized();
    }

    // OUTPUT clause
    if (this.lexer.isKeyword('OUTPUT')) {
      this.lexer.next();
      this.parseExpressionList();
    }

    // VALUES or SELECT or EXEC or DEFAULT VALUES
    if (this.lexer.isKeyword('VALUES')) {
      this.lexer.next();
      this.consumeParenthesized();
      // Multiple value lists
      while (this.lexer.isPunctuation(',')) {
        this.lexer.next();
        this.consumeParenthesized();
      }
    } else if (this.lexer.isKeyword('SELECT')) {
      this.parseSelectStatement();
    } else if (this.lexer.isKeyword('EXEC', 'EXECUTE')) {
      this.parseExecStatement();
    } else if (this.lexer.isKeyword('DEFAULT')) {
      this.lexer.next();
      if (this.lexer.isKeyword('VALUES')) this.lexer.next();
    }

    const end = this.lexer.current().range.start;
    return { type: 'insertStatement', range: { start, end } };
  }

  // ─── UPDATE Statement ─────────────────────────────────────────────────────

  private parseUpdateStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume UPDATE

    // Optional TOP
    if (this.lexer.isKeyword('TOP')) {
      this.lexer.next();
      if (this.lexer.isPunctuation('(')) this.consumeParenthesized();
    }

    // Table reference — check if missing
    if (this.lexer.isEof() || this.lexer.isKeyword('SET')) {
      const errorEnd = this.lexer.isEof() ? start : this.lexer.current().range.start;
      this.addError(
        `Incorrect syntax near 'UPDATE'. Expected table name.`,
        { start, end: errorEnd }
      );
    } else {
      this.parseTableReference();
    }

    // SET clause
    if (this.lexer.isKeyword('SET')) {
      this.lexer.next();
      this.parseSetAssignments();
    } else if (!this.lexer.isEof() && !this.isStatementStart()) {
      const errorPos = this.lexer.current().range;
      this.addError(
        `Incorrect syntax near '${this.lexer.current().value}'. Expected SET keyword.`,
        errorPos
      );
    }

    // OUTPUT clause
    if (this.lexer.isKeyword('OUTPUT')) {
      this.lexer.next();
      this.parseExpressionList();
    }

    // FROM clause
    if (this.lexer.isKeyword('FROM')) {
      this.parseFromClause();
    }

    // WHERE clause
    if (this.lexer.isKeyword('WHERE')) {
      this.parseWhereClause();
    }

    const end = this.lexer.current().range.start;
    return { type: 'updateStatement', range: { start, end } };
  }

  private parseSetAssignments(): void {
    // column = expression [, column = expression ...]
    let depth = 0;
    while (!this.lexer.isEof()) {
      if (depth === 0 && (this.lexer.isKeyword('FROM', 'WHERE', 'OUTPUT') ||
          this.isStatementStart())) {
        break;
      }
      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) depth--;
      this.lexer.next();
    }
  }

  // ─── DELETE Statement ─────────────────────────────────────────────────────

  private parseDeleteStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume DELETE

    // Optional TOP
    if (this.lexer.isKeyword('TOP')) {
      this.lexer.next();
      if (this.lexer.isPunctuation('(')) this.consumeParenthesized();
    }

    if (this.lexer.isKeyword('FROM')) this.lexer.next();

    // Table reference
    this.parseTableReference();

    // OUTPUT clause
    if (this.lexer.isKeyword('OUTPUT')) {
      this.lexer.next();
      this.parseExpressionList();
    }

    // FROM clause (for multi-table delete)
    if (this.lexer.isKeyword('FROM')) {
      this.parseFromClause();
    }

    // WHERE clause
    if (this.lexer.isKeyword('WHERE')) {
      this.parseWhereClause();
    }

    const end = this.lexer.current().range.start;
    return { type: 'deleteStatement', range: { start, end } };
  }

  // ─── CREATE Statement ─────────────────────────────────────────────────────

  private parseCreateStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume CREATE

    // Consume until next statement boundary or end
    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    return { type: 'createStatement', range: { start, end } };
  }

  // ─── ALTER Statement ──────────────────────────────────────────────────────

  private parseAlterStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume ALTER

    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    return { type: 'alterStatement', range: { start, end } };
  }

  // ─── DROP Statement ───────────────────────────────────────────────────────

  private parseDropStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume DROP

    // DROP TABLE/VIEW/PROCEDURE/FUNCTION/INDEX/SCHEMA/DATABASE
    if (this.lexer.current().type === 'keyword') {
      this.lexer.next(); // object type
    }

    // IF EXISTS
    if (this.lexer.isKeyword('IF')) {
      this.lexer.next();
      if (this.lexer.isKeyword('EXISTS')) this.lexer.next();
    }

    // Object name(s)
    this.consumeUntilClauseOrEnd();

    const end = this.lexer.current().range.start;
    return { type: 'dropStatement', range: { start, end } };
  }

  // ─── EXEC Statement ───────────────────────────────────────────────────────

  private parseExecStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume EXEC/EXECUTE

    // Procedure name or dynamic SQL
    if (this.lexer.isPunctuation('(')) {
      // EXEC(dynamic_sql)
      this.consumeParenthesized();
    } else {
      // Procedure name and parameters
      this.consumeUntilClauseOrEnd();
    }

    const end = this.lexer.current().range.start;
    return { type: 'execStatement', range: { start, end } };
  }

  // ─── DECLARE Statement ────────────────────────────────────────────────────

  private parseDeclareStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume DECLARE

    // DECLARE @var type [= value] [, @var2 type [= value]]
    // or DECLARE @table TABLE (...)
    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    return { type: 'declareStatement', range: { start, end } };
  }

  // ─── SET Statement ────────────────────────────────────────────────────────

  private parseSetStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume SET

    // SET @var = expr, SET NOCOUNT ON, SET ANSI_NULLS ON, etc.
    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    return { type: 'setStatement', range: { start, end } };
  }

  // ─── IF Statement ─────────────────────────────────────────────────────────

  private parseIfStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    const children: TSqlNode[] = [];
    this.lexer.next(); // consume IF

    // Condition
    this.parseExpression();

    // Then branch (single statement or BEGIN...END)
    const thenStmt = this.parseStatement();
    if (thenStmt) children.push(thenStmt);

    // Optional ELSE
    if (this.lexer.isKeyword('ELSE')) {
      this.lexer.next();
      const elseStmt = this.parseStatement();
      if (elseStmt) children.push(elseStmt);
    }

    const end = this.getLastEnd(children, start);
    return { type: 'ifStatement', range: { start, end }, children };
  }

  // ─── WHILE Statement ──────────────────────────────────────────────────────

  private parseWhileStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    const children: TSqlNode[] = [];
    this.lexer.next(); // consume WHILE

    // Condition
    this.parseExpression();

    // Body (single statement or BEGIN...END)
    const body = this.parseStatement();
    if (body) children.push(body);

    const end = this.getLastEnd(children, start);
    return { type: 'whileStatement', range: { start, end }, children };
  }

  // ─── BEGIN/END Block ──────────────────────────────────────────────────────

  private parseBeginBlock(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume BEGIN

    // Check for BEGIN TRY / BEGIN CATCH
    if (this.lexer.isKeyword('TRY')) {
      return this.parseTryCatchBlock(start);
    }
    if (this.lexer.isKeyword('CATCH')) {
      // This shouldn't happen at top level, but handle gracefully
      return this.parseCatchBlock(start);
    }

    // Check for BEGIN TRANSACTION / BEGIN TRAN
    if (this.lexer.isKeyword('TRANSACTION', 'TRAN')) {
      this.lexer.next();
      // Optional transaction name
      if (this.lexer.current().type === 'identifier') {
        this.lexer.next();
      }
      const end = this.lexer.current().range.start;
      return { type: 'beginEndBlock', range: { start, end } };
    }

    const children: TSqlNode[] = [];

    // Parse statements until END
    while (!this.lexer.isEof() && !this.lexer.isKeyword('END')) {
      // Skip semicolons
      while (this.lexer.isPunctuation(';')) {
        this.lexer.next();
      }
      if (this.lexer.isEof() || this.lexer.isKeyword('END')) break;

      const stmt = this.parseStatement();
      if (stmt) children.push(stmt);
    }

    // Consume END
    if (this.lexer.isKeyword('END')) {
      this.lexer.next();
    } else {
      this.addError('Expected END to close BEGIN block', this.lexer.current().range);
    }

    const end = this.lexer.current().range.start;
    return { type: 'beginEndBlock', range: { start, end }, children };
  }

  // ─── TRY/CATCH Block ──────────────────────────────────────────────────────

  private parseTryCatchBlock(start: SourcePosition): TSqlNode {
    this.lexer.next(); // consume TRY
    const children: TSqlNode[] = [];

    // Parse TRY body until END TRY
    while (!this.lexer.isEof()) {
      if (this.lexer.isKeyword('END')) {
        const next = this.lexer.peekToken(1);
        if (next.value.toUpperCase() === 'TRY') {
          break;
        }
      }
      // Skip semicolons
      while (this.lexer.isPunctuation(';')) {
        this.lexer.next();
      }
      if (this.lexer.isEof()) break;
      if (this.lexer.isKeyword('END')) {
        const next = this.lexer.peekToken(1);
        if (next.value.toUpperCase() === 'TRY') break;
      }

      const stmt = this.parseStatement();
      if (stmt) children.push(stmt);
    }

    // Consume END TRY
    if (this.lexer.isKeyword('END')) {
      this.lexer.next();
      if (this.lexer.isKeyword('TRY')) this.lexer.next();
    }

    // BEGIN CATCH
    if (this.lexer.isKeyword('BEGIN')) {
      this.lexer.next();
      if (this.lexer.isKeyword('CATCH')) {
        this.lexer.next();

        // Parse CATCH body until END CATCH
        while (!this.lexer.isEof()) {
          if (this.lexer.isKeyword('END')) {
            const next = this.lexer.peekToken(1);
            if (next.value.toUpperCase() === 'CATCH') break;
          }
          while (this.lexer.isPunctuation(';')) {
            this.lexer.next();
          }
          if (this.lexer.isEof()) break;
          if (this.lexer.isKeyword('END')) {
            const next = this.lexer.peekToken(1);
            if (next.value.toUpperCase() === 'CATCH') break;
          }

          const stmt = this.parseStatement();
          if (stmt) children.push(stmt);
        }

        // Consume END CATCH
        if (this.lexer.isKeyword('END')) {
          this.lexer.next();
          if (this.lexer.isKeyword('CATCH')) this.lexer.next();
        }
      }
    }

    const end = this.lexer.current().range.start;
    return { type: 'tryCatchBlock', range: { start, end }, children };
  }

  private parseCatchBlock(start: SourcePosition): TSqlNode {
    this.lexer.next(); // consume CATCH
    const children: TSqlNode[] = [];

    while (!this.lexer.isEof()) {
      if (this.lexer.isKeyword('END')) {
        const next = this.lexer.peekToken(1);
        if (next.value.toUpperCase() === 'CATCH') break;
      }
      while (this.lexer.isPunctuation(';')) this.lexer.next();
      if (this.lexer.isEof()) break;
      if (this.lexer.isKeyword('END')) {
        const next = this.lexer.peekToken(1);
        if (next.value.toUpperCase() === 'CATCH') break;
      }
      const stmt = this.parseStatement();
      if (stmt) children.push(stmt);
    }

    if (this.lexer.isKeyword('END')) {
      this.lexer.next();
      if (this.lexer.isKeyword('CATCH')) this.lexer.next();
    }

    const end = this.lexer.current().range.start;
    return { type: 'tryCatchBlock', range: { start, end }, children };
  }

  // ─── MERGE Statement ──────────────────────────────────────────────────────

  private parseMergeStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume MERGE

    // Optional TOP
    if (this.lexer.isKeyword('TOP')) {
      this.lexer.next();
      if (this.lexer.isPunctuation('(')) this.consumeParenthesized();
    }

    // Optional INTO
    if (this.lexer.isKeyword('INTO')) this.lexer.next();

    // Target table
    this.parseTableReference();

    // USING
    if (this.lexer.isKeyword('USING')) {
      this.lexer.next();
      this.parseTableReference();
    }

    // ON
    if (this.lexer.isKeyword('ON')) {
      this.lexer.next();
      this.parseExpression();
    }

    // WHEN MATCHED / WHEN NOT MATCHED clauses
    while (this.lexer.isKeyword('WHEN')) {
      this.lexer.next();
      // NOT MATCHED / MATCHED
      if (this.lexer.isKeyword('NOT')) this.lexer.next();
      if (this.lexer.isKeyword('MATCHED')) this.lexer.next();
      // BY TARGET / BY SOURCE
      if (this.lexer.isKeyword('BY')) {
        this.lexer.next();
        if (this.lexer.isKeyword('TARGET', 'SOURCE')) this.lexer.next();
      }
      // AND condition
      if (this.lexer.isKeyword('AND')) {
        this.lexer.next();
        this.parseExpression();
      }
      // THEN
      if (this.lexer.isKeyword('THEN')) {
        this.lexer.next();
        // Action: INSERT, UPDATE, DELETE
        if (this.lexer.isKeyword('INSERT')) {
          this.lexer.next();
          if (this.lexer.isPunctuation('(')) this.consumeParenthesized();
          if (this.lexer.isKeyword('VALUES')) {
            this.lexer.next();
            if (this.lexer.isPunctuation('(')) this.consumeParenthesized();
          }
        } else if (this.lexer.isKeyword('UPDATE')) {
          this.lexer.next();
          if (this.lexer.isKeyword('SET')) {
            this.lexer.next();
            this.parseMergeSetAssignments();
          }
        } else if (this.lexer.isKeyword('DELETE')) {
          this.lexer.next();
        }
      }
    }

    // OUTPUT clause
    if (this.lexer.isKeyword('OUTPUT')) {
      this.lexer.next();
      this.parseExpressionList();
    }

    // Semicolon (MERGE requires it)
    if (this.lexer.isPunctuation(';')) {
      this.lexer.next();
    }

    const end = this.lexer.current().range.start;
    return { type: 'mergeStatement', range: { start, end } };
  }

  private parseMergeSetAssignments(): void {
    let depth = 0;
    while (!this.lexer.isEof()) {
      if (depth === 0 && (this.lexer.isKeyword('WHEN', 'OUTPUT') ||
          this.lexer.isPunctuation(';') || this.isStatementStart())) {
        break;
      }
      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) depth--;
      this.lexer.next();
    }
  }

  // ─── WITH / CTE ───────────────────────────────────────────────────────────

  private parseWithCte(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.lexer.next(); // consume WITH

    // Check if this is a table hint WITH (NOLOCK) — shouldn't happen at statement level
    if (this.lexer.isPunctuation('(')) {
      // Likely a table hint at wrong position, consume it
      this.consumeParenthesized();
      const end = this.lexer.current().range.start;
      return { type: 'unknown', range: { start, end } };
    }

    const children: TSqlNode[] = [];

    // Parse CTE definitions
    do {
      const cteStart = this.lexer.current().range.start;

      // CTE name
      if (this.lexer.current().type === 'identifier' || this.lexer.current().type === 'keyword') {
        this.lexer.next();
      }

      // Optional column list
      if (this.lexer.isPunctuation('(')) {
        this.consumeParenthesized();
      }

      // AS
      if (this.lexer.isKeyword('AS')) {
        this.lexer.next();
      }

      // CTE body (parenthesized SELECT)
      if (this.lexer.isPunctuation('(')) {
        this.consumeParenthesized();
      }

      const cteEnd = this.lexer.current().range.start;
      children.push({ type: 'cteDefinition', range: { start: cteStart, end: cteEnd } });

      // More CTEs?
      if (this.lexer.isPunctuation(',')) {
        this.lexer.next();
      } else {
        break;
      }
    } while (!this.lexer.isEof());

    // The main statement after CTEs (SELECT, INSERT, UPDATE, DELETE, MERGE)
    const mainStmt = this.parseStatement();
    if (mainStmt) children.push(mainStmt);

    const end = this.getLastEnd(children, start);
    return { type: 'selectStatement', range: { start, end }, children };
  }

  private isWithCteContext(): boolean {
    // Check if WITH is followed by an identifier then AS (CTE pattern)
    // vs WITH followed by ( which is a table hint
    const next = this.lexer.peekToken(1);
    if (next.type === 'punctuation' && next.value === '(') return false;
    return true;
  }

  // ─── Simple Statement (RETURN, PRINT, RAISERROR, THROW, USE, etc.) ────────

  private parseSimpleStatement(): TSqlNode {
    const start = this.lexer.current().range.start;
    const kw = this.lexer.current().value.toUpperCase();
    this.lexer.next(); // consume keyword

    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    const type: TSqlNodeType = 'unknown';
    return { type, range: { start, end } };
  }

  // ─── Unknown Statement ────────────────────────────────────────────────────

  private parseUnknownStatement(): TSqlNode | null {
    const start = this.lexer.current().range.start;

    // Consume tokens until we hit a statement boundary
    if (this.lexer.isEof()) return null;

    this.consumeUntilStatementEnd();

    const end = this.lexer.current().range.start;
    if (end.line === start.line && end.column === start.column) {
      // Didn't consume anything — force advance to avoid infinite loop
      this.lexer.next();
      const newEnd = this.lexer.current().range.start;
      return { type: 'unknown', range: { start, end: newEnd } };
    }
    return { type: 'unknown', range: { start, end } };
  }

  // ─── Expression Parsing ───────────────────────────────────────────────────

  /**
   * Parse an expression — consumes tokens until a clause boundary is reached.
   * This is a simplified expression parser that handles parentheses, CASE, and subqueries.
   */
  private parseExpression(): void {
    let depth = 0;
    while (!this.lexer.isEof()) {
      // Stop at clause boundaries when at top level
      if (depth === 0 && this.isExpressionEnd()) {
        break;
      }

      // Handle CASE...END
      if (this.lexer.isKeyword('CASE')) {
        this.parseCaseExpression();
        continue;
      }

      // Handle subqueries
      if (this.lexer.isPunctuation('(')) {
        depth++;
        this.lexer.next();
        continue;
      }
      if (this.lexer.isPunctuation(')')) {
        if (depth > 0) {
          depth--;
          this.lexer.next();
          continue;
        }
        break; // Unmatched close paren — stop
      }

      this.lexer.next();
    }
  }

  private isExpressionEnd(): boolean {
    if (this.lexer.isPunctuation(';')) return true;
    if (this.lexer.isPunctuation(',')) return true;
    if (this.lexer.isPunctuation(')')) return true;
    // BEGIN is a statement start that also terminates expressions in IF/WHILE contexts
    if (this.lexer.isKeyword('BEGIN')) return true;
    // WHEN/THEN/ELSE/END terminate expressions in CASE and MERGE contexts
    if (this.lexer.isKeyword('WHEN', 'THEN', 'ELSE', 'END')) return true;
    return this.isClauseKeyword() || this.isStatementStart();
  }

  private parseExpressionList(): void {
    this.parseExpression();
    while (this.lexer.isPunctuation(',')) {
      this.lexer.next();
      this.parseExpression();
    }
  }

  private parseCaseExpression(): void {
    this.lexer.next(); // consume CASE

    // Simple CASE: CASE expr WHEN ...
    // Searched CASE: CASE WHEN condition THEN ...
    if (!this.lexer.isKeyword('WHEN')) {
      // Simple CASE — consume the test expression
      while (!this.lexer.isEof() && !this.lexer.isKeyword('WHEN', 'END')) {
        if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        } else {
          this.lexer.next();
        }
      }
    }

    // WHEN ... THEN ... pairs
    while (this.lexer.isKeyword('WHEN')) {
      this.lexer.next(); // WHEN
      // Condition/value
      while (!this.lexer.isEof() && !this.lexer.isKeyword('THEN')) {
        if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        } else {
          this.lexer.next();
        }
      }
      if (this.lexer.isKeyword('THEN')) this.lexer.next();
      // Result expression
      while (!this.lexer.isEof() && !this.lexer.isKeyword('WHEN', 'ELSE', 'END')) {
        if (this.lexer.isKeyword('CASE')) {
          this.parseCaseExpression();
        } else if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        } else {
          this.lexer.next();
        }
      }
    }

    // ELSE
    if (this.lexer.isKeyword('ELSE')) {
      this.lexer.next();
      while (!this.lexer.isEof() && !this.lexer.isKeyword('END')) {
        if (this.lexer.isKeyword('CASE')) {
          this.parseCaseExpression();
        } else if (this.lexer.isPunctuation('(')) {
          this.consumeParenthesized();
        } else {
          this.lexer.next();
        }
      }
    }

    // END
    if (this.lexer.isKeyword('END')) {
      this.lexer.next();
    }
  }

  private parseSubquery(): TSqlNode {
    const start = this.lexer.current().range.start;
    this.consumeParenthesized();
    const end = this.lexer.current().range.start;
    return { type: 'subquery', range: { start, end } };
  }

  // ─── Helper Methods ───────────────────────────────────────────────────────

  private isClauseKeyword(): boolean {
    return this.lexer.isKeyword(
      'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER',
      'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'INNER', 'LEFT',
      'RIGHT', 'FULL', 'CROSS', 'ON', 'INTO', 'VALUES', 'SET',
      'OUTPUT', 'OPTION', 'FOR', 'OFFSET', 'FETCH'
    );
  }

  private isStatementStart(): boolean {
    if (this.lexer.current().type !== 'keyword') return false;
    return this.lexer.isKeyword(
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
      'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN',
      'MERGE', 'WITH', 'RETURN', 'PRINT', 'RAISERROR', 'THROW',
      'USE', 'GRANT', 'REVOKE', 'DENY', 'WAITFOR', 'BREAK', 'CONTINUE', 'GOTO'
    );
  }

  /**
   * Consume tokens until we reach a statement boundary.
   * Respects parenthesis nesting and BEGIN/END blocks.
   */
  private consumeUntilStatementEnd(): void {
    let depth = 0;
    let beginDepth = 0;

    while (!this.lexer.isEof()) {
      if (this.lexer.isPunctuation(';') && depth === 0 && beginDepth === 0) {
        this.lexer.next();
        return;
      }

      if (depth === 0 && beginDepth === 0) {
        if (this.isStatementStart()) return;
        // Stop at END keyword (closes a BEGIN block in the parent scope)
        if (this.lexer.isKeyword('END')) return;
        // Stop at ELSE (for IF statements)
        if (this.lexer.isKeyword('ELSE')) return;
      }

      if (this.lexer.isKeyword('BEGIN')) {
        beginDepth++;
        this.lexer.next();
        continue;
      }
      if (this.lexer.isKeyword('END') && beginDepth > 0) {
        beginDepth--;
        this.lexer.next();
        continue;
      }

      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) {
        if (depth > 0) depth--;
      }

      this.lexer.next();
    }
  }

  /**
   * Consume tokens until a clause keyword or statement end.
   */
  private consumeUntilClauseOrEnd(): void {
    let depth = 0;
    while (!this.lexer.isEof()) {
      if (depth === 0) {
        if (this.lexer.isPunctuation(';')) return;
        if (this.isStatementStart() || this.isClauseKeyword()) return;
      }
      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) {
        if (depth > 0) depth--;
        else return;
      }
      this.lexer.next();
    }
  }

  /**
   * Consume a parenthesized expression (including nested parens).
   */
  private consumeParenthesized(): void {
    if (!this.lexer.isPunctuation('(')) return;
    this.lexer.next(); // consume (
    let depth = 1;
    while (!this.lexer.isEof() && depth > 0) {
      if (this.lexer.isPunctuation('(')) depth++;
      if (this.lexer.isPunctuation(')')) depth--;
      this.lexer.next();
    }
  }

  private getLastEnd(children: TSqlNode[], fallback: SourcePosition): SourcePosition {
    if (children.length > 0) {
      const end = children[children.length - 1].range.end;
      return { line: end.line, column: end.column };
    }
    const pos = this.lexer.current().range.start;
    return { line: pos.line, column: pos.column };
  }

  private addError(message: string, range: SourceRange): void {
    this.errors.push({ message, range });
  }
}


// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a single T-SQL batch into an AST.
 * Returns a ParseResult with the AST and any syntax errors found.
 */
export function parseBatch(text: string): ParseResult {
  if (!text || text.trim().length === 0) {
    return { ast: null, errors: [] };
  }

  const parser = new Parser(text);
  return parser.parse();
}

/**
 * Parse a multi-batch document (splits on GO, parses each batch).
 * GO is recognized case-insensitively on its own line (optionally followed by whitespace).
 * GO within string literals or block comments is NOT treated as a separator.
 */
export function parseDocument(text: string): ParseResult[] {
  const batches = splitOnGo(text);
  return batches.map(batch => {
    const result = parseBatch(batch.text);
    // Adjust source positions by the batch's starting line
    if (result.ast && batch.startLine > 0) {
      adjustNodeLines(result.ast, batch.startLine);
    }
    if (batch.startLine > 0) {
      for (const error of result.errors) {
        error.range.start.line += batch.startLine;
        error.range.end.line += batch.startLine;
      }
    }
    return result;
  });
}

// ─── GO Batch Splitting ─────────────────────────────────────────────────────

interface BatchInfo {
  text: string;
  startLine: number;
}

/**
 * Split a document into batches on GO boundaries.
 * GO must be on its own line (case-insensitive, optional surrounding whitespace).
 * GO inside string literals or block comments is not treated as a separator.
 */
function splitOnGo(text: string): BatchInfo[] {
  const lines = text.split(/\r?\n/);
  const batches: BatchInfo[] = [];
  let currentBatchLines: string[] = [];
  let batchStartLine = 0;

  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlockComment && !inString) {
      // Check if this line is a standalone GO separator
      if (/^\s*GO\s*$/i.test(line)) {
        const batchText = currentBatchLines.join('\n');
        if (batchText.trim().length > 0) {
          batches.push({ text: batchText, startLine: batchStartLine });
        }
        currentBatchLines = [];
        batchStartLine = i + 1;
        continue;
      }
    }

    currentBatchLines.push(line);

    // Update state by scanning the line
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = j + 1 < line.length ? line[j + 1] : '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          j++;
        }
      } else if (inString) {
        if (ch === "'") {
          if (next === "'") {
            j++; // escaped quote
          } else {
            inString = false;
          }
        }
      } else {
        if (ch === '-' && next === '-') break; // line comment
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          j++;
        } else if (ch === "'") {
          inString = true;
        }
      }
    }
  }

  // Final batch
  const batchText = currentBatchLines.join('\n');
  if (batchText.trim().length > 0) {
    batches.push({ text: batchText, startLine: batchStartLine });
  }

  return batches;
}

// ─── AST Utilities ──────────────────────────────────────────────────────────

/**
 * Recursively adjust line numbers in an AST node by a given offset.
 * Creates new range objects to avoid shared-reference mutation issues.
 */
function adjustNodeLines(node: TSqlNode, lineOffset: number): void {
  node.range = {
    start: { line: node.range.start.line + lineOffset, column: node.range.start.column },
    end: { line: node.range.end.line + lineOffset, column: node.range.end.column },
  };
  if (node.children) {
    for (const child of node.children) {
      adjustNodeLines(child, lineOffset);
    }
  }
}
