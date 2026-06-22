/**
 * SQL syntax highlighter using a character-by-character state-machine tokenizer.
 * Produces HTML with <span class="kw|str|num|op|cmt|fn"> tokens.
 * Designed to be used both in webview inline scripts and in test files.
 */

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
  'BETWEEN', 'IS', 'NULL', 'AS', 'ON', 'INNER', 'LEFT', 'RIGHT', 'OUTER',
  'CROSS', 'TOP', 'ORDER', 'BY', 'GROUP', 'HAVING', 'INSERT', 'UPDATE',
  'DELETE', 'SET', 'INTO', 'VALUES', 'ASC', 'DESC', 'DISTINCT', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END'
]);

const FUNCTIONS = new Set([
  'COUNT', 'SUM', 'MAX', 'MIN', 'AVG', 'COALESCE', 'ISNULL', 'CAST',
  'CONVERT', 'GETDATE', 'LEN', 'SUBSTRING', 'UPPER', 'LOWER', 'DATEADD',
  'DATEDIFF'
]);

const SINGLE_CHAR_OPERATORS = new Set(['=', '>', '<', '+', '-', '*', '/', '%']);

const enum State {
  DEFAULT,
  STRING,
  LINE_COMMENT,
  BLOCK_COMMENT
}

function escapeHtml(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    switch (ch) {
      case '&': result += '&amp;'; break;
      case '<': result += '&lt;'; break;
      case '>': result += '&gt;'; break;
      case '"': result += '&quot;'; break;
      default: result += ch;
    }
  }
  return result;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') ||
         (ch >= 'A' && ch <= 'Z') ||
         (ch >= '0' && ch <= '9') ||
         ch === '_';
}

export function highlightSql(sql: string): string {
  if (!sql) {
    return '';
  }

  let output = '';
  let state: State = State.DEFAULT;
  let i = 0;
  const len = sql.length;

  // Buffer for accumulating token content within STRING, LINE_COMMENT, BLOCK_COMMENT
  let tokenBuffer = '';

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    switch (state) {
      case State.DEFAULT: {
        // Check for line comment start: --
        if (ch === '-' && next === '-') {
          state = State.LINE_COMMENT;
          tokenBuffer = '--';
          i += 2;
          break;
        }

        // Check for block comment start: /*
        if (ch === '/' && next === '*') {
          state = State.BLOCK_COMMENT;
          tokenBuffer = '/*';
          i += 2;
          break;
        }

        // Check for string literal start: '
        if (ch === "'") {
          state = State.STRING;
          tokenBuffer = "'";
          i += 1;
          break;
        }

        // Check for multi-character operators: <>, !=, >=, <=
        if ((ch === '<' && next === '>') ||
            (ch === '!' && next === '=') ||
            (ch === '>' && next === '=') ||
            (ch === '<' && next === '=')) {
          output += `<span class="op">${escapeHtml(ch + next)}</span>`;
          i += 2;
          break;
        }

        // Check for single-character operators
        if (SINGLE_CHAR_OPERATORS.has(ch)) {
          output += `<span class="op">${escapeHtml(ch)}</span>`;
          i += 1;
          break;
        }

        // Check for numeric literal (integer or decimal)
        if (isDigit(ch) || (ch === '.' && next !== '' && isDigit(next))) {
          let numStr = '';
          let hasDot = false;
          while (i < len) {
            const c = sql[i];
            if (isDigit(c)) {
              numStr += c;
              i++;
            } else if (c === '.' && !hasDot) {
              hasDot = true;
              numStr += c;
              i++;
            } else {
              break;
            }
          }
          output += `<span class="num">${escapeHtml(numStr)}</span>`;
          break;
        }

        // Check for word (keyword, function, or identifier)
        if (isWordChar(ch) && !isDigit(ch)) {
          let word = '';
          while (i < len && isWordChar(sql[i])) {
            word += sql[i];
            i++;
          }
          const upper = word.toUpperCase();
          if (KEYWORDS.has(upper)) {
            output += `<span class="kw">${escapeHtml(word)}</span>`;
          } else if (FUNCTIONS.has(upper)) {
            output += `<span class="fn">${escapeHtml(word)}</span>`;
          } else {
            output += escapeHtml(word);
          }
          break;
        }

        // Everything else: whitespace, punctuation, etc. — plain escaped text
        output += escapeHtml(ch);
        i += 1;
        break;
      }

      case State.STRING: {
        if (ch === "'") {
          // Check for escaped quote ''
          if (next === "'") {
            tokenBuffer += "''";
            i += 2;
          } else {
            // End of string
            tokenBuffer += "'";
            output += `<span class="str">${escapeHtml(tokenBuffer)}</span>`;
            tokenBuffer = '';
            state = State.DEFAULT;
            i += 1;
          }
        } else {
          tokenBuffer += ch;
          i += 1;
        }
        break;
      }

      case State.LINE_COMMENT: {
        if (ch === '\n') {
          // End of line comment — emit comment token, then the newline as plain text
          output += `<span class="cmt">${escapeHtml(tokenBuffer)}</span>`;
          output += escapeHtml(ch);
          tokenBuffer = '';
          state = State.DEFAULT;
          i += 1;
        } else {
          tokenBuffer += ch;
          i += 1;
        }
        break;
      }

      case State.BLOCK_COMMENT: {
        if (ch === '*' && next === '/') {
          // End of block comment
          tokenBuffer += '*/';
          output += `<span class="cmt">${escapeHtml(tokenBuffer)}</span>`;
          tokenBuffer = '';
          state = State.DEFAULT;
          i += 2;
        } else {
          tokenBuffer += ch;
          i += 1;
        }
        break;
      }
    }
  }

  // Handle unterminated tokens at end of input
  if (tokenBuffer) {
    switch (state) {
      case State.STRING:
        output += `<span class="str">${escapeHtml(tokenBuffer)}</span>`;
        break;
      case State.LINE_COMMENT:
        output += `<span class="cmt">${escapeHtml(tokenBuffer)}</span>`;
        break;
      case State.BLOCK_COMMENT:
        output += `<span class="cmt">${escapeHtml(tokenBuffer)}</span>`;
        break;
    }
  }

  return output;
}
