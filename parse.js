// parse.js — a fast Markdown renderer that returns, for every input, the same
// HTML that marked 18.1.3 returns with its default options (GFM on).
//
// Written from scratch as a line-oriented block parser plus a scanner-based
// inline parser with a delimiter stack. No dependencies, no state shared
// between calls: each parse() lexes its input fresh.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const CC_TAB = 9, CC_LF = 10, CC_SPACE = 32, CC_BANG = 33, CC_QUOT = 34,
  CC_HASH = 35, CC_AMP = 38, CC_APOS = 39, CC_LPAREN = 40, CC_RPAREN = 41,
  CC_STAR = 42, CC_PLUS = 43, CC_MINUS = 45, CC_SLASH = 47, CC_COLON = 58,
  CC_SEMI = 59, CC_LT = 60, CC_EQ = 61, CC_GT = 62, CC_LBRACKET = 91,
  CC_BACKSLASH = 92, CC_RBRACKET = 93, CC_UNDERSCORE = 95, CC_BACKTICK = 96,
  CC_LBRACE = 123, CC_TILDE = 126;

function isDigitCode(c) { return c >= 48 && c <= 57; }
function isAlphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isWordCode(c) { return isAlphaCode(c) || isDigitCode(c) || c === CC_UNDERSCORE; }
function isHexCode(c) { return isDigitCode(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }

/** ASCII punctuation, per the CommonMark definition. */
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const WS_RE = /\s/;
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isWsCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || WS_RE.test(ch); }
function isPunctCh(ch) {
  if (ch.length === 1 && isAsciiPunct(ch)) return true;
  return PUNCT_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** Escape the five HTML-special characters (marked escapes quotes in text too). */
function escapeHtml(s) {
  return s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
    s.indexOf('"') < 0 && s.indexOf("'") < 0
    ? s
    : s.replace(ESCAPE_RE, (ch) => ESCAPES[ch]);
}

const ENTITY_AT_RE = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/y;

/**
 * Escape a string for an HTML attribute value, leaving entity references
 * (`&name;`, `&#123;`, `&#x1F;`) untouched, as marked does for href/title.
 */
function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      ENTITY_AT_RE.lastIndex = i;
      const m = ENTITY_AT_RE.exec(s);
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    // copy the plain run
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

const URL_ENCODE_EXTRA = new Set(['"', '<', '>', '[', ']', '\\', '^', '`', '{', '|', '}']);

/**
 * marked's href cleanup: percent-encode (as UTF-8, uppercase hex) every
 * character that is a control, a space, DEL or non-ASCII, plus a small set
 * of ASCII punctuation. Existing `%` sequences and everything else pass
 * through untouched.
 */
function cleanUrl(href) {
  let out = '';
  for (const ch of href) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
    if (cp > 0x20 && cp < 0x7F && !URL_ENCODE_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    let bytes;
    if (cp < 0x80) bytes = [cp];
    else if (cp < 0x800) bytes = [0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)];
    else if (cp < 0x10000) {
      bytes = [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)];
    } else {
      bytes = [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)];
    }
    for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line utilities (columns count tabs as advancing to the next multiple of 4)
// ---------------------------------------------------------------------------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}

/** Columns of leading whitespace (spaces/tabs) on a line. */
function leadingCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) col++;
    else if (c === CC_TAB) col += 4 - (col % 4);
    else break;
  }
  return col;
}

/**
 * The line's content after removing `cols` columns from the start.
 * A tab straddling the cut is expanded into the spaces that remain of it.
 */
function dropColumns(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else return ' '.repeat(col + w - cols) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

/**
 * List-item dedent: like dropColumns, but a tab straddling the boundary
 * is dropped whole rather than leaving a partial-space remainder
 * (a tab-indented line inside a list item loses the tab entirely).
 */
function dropColumnsWholeTab(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else return line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

/**
 * Rewrite a line's leading whitespace as spaces, preserving the column
 * count it had when the line started at column `baseCol` of its source.
 * Container stripping shifts a line's column frame, which would otherwise
 * change the widths of any tabs that follow in the leading run.
 */
function rebaseLeading(line, baseCol) {
  let col = baseCol;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (i === 0) return line;
  return ' '.repeat(col - baseCol) + line.slice(i);
}

// ---------------------------------------------------------------------------
// Shared scanners for link destinations, titles and labels
// ---------------------------------------------------------------------------

/** Unescape backslash escapes of ASCII punctuation in a raw fragment. */
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

/** Normalize a link label for definition lookup: whitespace collapsed,
 * case folded (full folding, so ß and ẞ both fold to ss). Backslash
 * escapes are NOT resolved — marked matches labels literally. */
const FOLD_MAP = {
  'ß': 'ss', 'ς': 'σ', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl',
  'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
};
function normalizeLabel(raw) {
  return raw.replace(/[ \t\n]+/g, ' ').trim().toLowerCase()
    .replace(/[ßςﬀ-ﬆ]/g, (ch) => FOLD_MAP[ch] ?? ch);
}

/**
 * Scan a bare (non-`<>`) link destination starting at `pos`.
 * Returns { value, end } with escapes resolved, or null when there is none.
 * Stops at whitespace or a `<`; parentheses must balance, and an unescaped
 * `)` at depth 0 ends the destination (it is the link's own closer).
 */
function scanBareDest(text, pos) {
  let i = pos;
  const n = text.length;
  let depth = 0;
  let out = '';
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c < 32) break;
    if (c === CC_BACKSLASH && i + 1 < n && isAsciiPunct(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (c === CC_LPAREN) { depth++; out += '('; i++; continue; }
    if (c === CC_RPAREN) {
      if (depth === 0) break;
      depth--; out += ')'; i++; continue;
    }
    if (c === CC_LT) break;
    out += text[i];
    i++;
  }
  return { value: out, end: i };
}

/**
 * Scan a link title starting at `pos` (text[pos] is `"`, `'` or `(`).
 * Returns { value, end } with escapes resolved, or null.
 */
function scanTitle(text, pos) {
  const open = text[pos];
  const close = open === '(' ? ')' : open;
  let i = pos + 1;
  const n = text.length;
  let out = '';
  let lineBlank = false; // current line holds only whitespace so far
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CC_BACKSLASH && i + 1 < n && isAsciiPunct(text[i + 1])) {
      out += text[i + 1];
      lineBlank = false;
      i += 2;
      continue;
    }
    if (open === '(' && c === CC_LPAREN) return null;
    if (text[i] === close) return { value: out, end: i + 1 };
    if (c === CC_LF) {
      if (lineBlank) return null; // titles may not span a blank line
      lineBlank = true;
      out += text[i];
      i++;
      continue;
    }
    if (c !== CC_SPACE && c !== CC_TAB) lineBlank = false;
    out += text[i];
    i++;
  }
  return null;
}

/** Skip spaces/tabs (not newlines). Returns the new position. */
function skipSpaces(text, pos) {
  const n = text.length;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === CC_SPACE || c === CC_TAB) pos++;
    else break;
  }
  return pos;
}

/**
 * Parse the inside of an inline link's parentheses, starting just after `(`.
 * Returns { href, title, end } (end is just past the closing `)`) or null.
 */
function parseLinkParens(text, pos) {
  const n = text.length;
  let i = pos;
  // whitespace (including newlines) may appear after the opening paren
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF) i++;
    else break;
  }
  let href;
  if (text[i] === '<') {
    // pointy destination: no line endings or unescaped < > inside
    let j = i + 1;
    let out = '';
    let ok = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === CC_LF) break;
      if (c === CC_BACKSLASH && j + 1 < n && isAsciiPunct(text[j + 1])) {
        out += text[j + 1];
        j += 2;
        continue;
      }
      if (c === CC_LT) break;
      if (c === CC_GT) { ok = true; break; }
      out += text[j];
      j++;
    }
    if (!ok) return null;
    href = out;
    i = j + 1;
  } else {
    const d = scanBareDest(text, i);
    href = d.value;
    i = d.end;
  }
  // optional whitespace, optional title, optional whitespace, then `)`
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF) j++;
    else break;
  }
  let title = null;
  if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
    // a title must be separated from the destination by whitespace
    if (j === i && href !== '') return null;
    const t = scanTitle(text, j);
    if (!t) return null;
    title = t.value;
    j = t.end;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF) j++;
      else break;
    }
  }
  if (text[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// ---------------------------------------------------------------------------
// Block-level matchers. Each takes a raw source line; container indentation
// has already been stripped by the caller, so a construct may sit under at
// most 3 columns of leading whitespace here.
// ---------------------------------------------------------------------------

function matchFenceStart(line) {
  const indent = leadingCols(line);
  if (indent > 3) return null;
  const s = dropColumns(line, indent);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return null;
  const info = s.slice(len).replace(/^[ \t]+|[ \t]+$/g, '');
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len, info, indent };
}

function matchATX(line) {
  const indent = leadingCols(line);
  if (indent > 3) return null;
  const s = dropColumns(line, indent);
  let run = 0;
  while (run < s.length && s[run] === '#') run++;
  if (run === 0 || run > 6) return null;
  if (run < s.length && s[run] !== ' ' && s[run] !== '\t') return null;
  let rest = s.slice(run).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  const tail = /#+$/.exec(rest);
  if (tail) {
    const idx = rest.length - tail[0].length;
    if (idx === 0 || rest[idx - 1] === ' ' || rest[idx - 1] === '\t') {
      rest = rest.slice(0, idx).replace(/[ \t]+$/, '');
    }
  }
  return { level: run, text: rest };
}

function isThematicBreak(line) {
  const indent = leadingCols(line);
  if (indent > 3) return false;
  const s = dropColumns(line, indent);
  let ch = '';
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') continue;
    if (ch === '') {
      if (c !== '*' && c !== '-' && c !== '_') return false;
      ch = c;
      count = 1;
    } else if (c === ch) count++;
    else return false;
  }
  return count >= 3;
}

/** 0 = not a setext underline, 1 = `===` (h1), 2 = `---` (h2). */
function setextLevel(line) {
  const indent = leadingCols(line);
  if (indent > 3) return 0;
  const s = dropColumns(line, indent).replace(/[ \t]+$/, '');
  if (!s) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 1; i < s.length; i++) if (s[i] !== c) return 0;
  return c === '=' ? 1 : 2;
}

function startsBlockquote(line) {
  const indent = leadingCols(line);
  if (indent > 3) return false;
  return dropColumns(line, indent)[0] === '>';
}

function matchListMarker(line) {
  const indent = leadingCols(line);
  if (indent > 3) return null;
  const s = dropColumns(line, indent);
  if (!s) return null;
  const c = s[0];
  let ordered = false;
  let num = 0;
  let delim = '';
  let markerLen = 0;
  if (c === '-' || c === '+' || c === '*') {
    delim = c;
    markerLen = 1;
  } else if (isDigitCode(s.charCodeAt(0))) {
    let k = 0;
    while (k < s.length && isDigitCode(s.charCodeAt(k))) k++;
    if (k > 9) return null;
    if (s[k] !== '.' && s[k] !== ')') return null;
    ordered = true;
    num = parseInt(s.slice(0, k), 10);
    delim = s[k];
    markerLen = k + 1;
  } else return null;
  const after = s[markerLen];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  return { ordered, delim, num, indent, markerEndCol: indent + markerLen, markerLen, deind: s };
}

/** Content indent and whether the marker line itself carries content. */
function markerInfo(m) {
  const s = m.deind;
  let col = m.markerEndCol;
  let k = m.markerLen;
  let w = 0;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === CC_SPACE) { w++; col++; k++; }
    else if (c === CC_TAB) { const tw = 4 - (col % 4); w += tw; col += tw; k++; }
    else break;
  }
  const hasContent = k < s.length;
  let contentIndent;
  if (!hasContent) contentIndent = m.markerEndCol + 1;
  else if (w <= 4) contentIndent = m.markerEndCol + w;
  else contentIndent = m.markerEndCol + 1;
  return { contentIndent, hasContent };
}

// ---------------------------------------------------------------------------
// HTML blocks
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
  'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol ' +
  'optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

/**
 * Scan an HTML tag (open, close, comment, CDATA, processing instruction or
 * declaration) starting at text[pos] === '<'. Returns the end index
 * (exclusive) or -1 when the text at pos is none of those.
 */
function scanHtmlTag(text, pos) {
  const n = text.length;
  if (text.startsWith('<!--', pos)) {
    if (text.startsWith('<!-->', pos)) return pos + 5;
    if (text.startsWith('<!--->', pos)) return pos + 6;
    const end = text.indexOf('-->', pos + 4);
    if (end < 0) return -1;
    const inner = text.slice(pos + 4, end);
    if (inner.startsWith('>') || inner.startsWith('->') || inner.endsWith('-')) return -1;
    return end + 3;
  }
  if (text.startsWith('<![CDATA[', pos)) {
    const end = text.indexOf(']]>', pos + 9);
    return end < 0 ? -1 : end + 3;
  }
  if (text.startsWith('<?', pos)) {
    const end = text.indexOf('?>', pos + 2);
    return end < 0 ? -1 : end + 2;
  }
  if (text.startsWith('<!', pos)) {
    const c = text.charCodeAt(pos + 2);
    if (c >= 65 && c <= 90) {
      const end = text.indexOf('>', pos + 2);
      return end < 0 ? -1 : end + 1;
    }
    return -1;
  }
  let j = pos + 1;
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlphaCode(text.charCodeAt(j))) return -1;
  j++;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (isAlphaCode(c) || isDigitCode(c) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    return text[j] === '>' ? j + 1 : -1;
  }
  while (true) {
    let ws = 0;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) { j++; ws++; }
    if (j >= n) return -1;
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && text[j + 1] === '>') return j + 2;
    if (ws === 0) return -1;
    const ac = text.charCodeAt(j);
    if (!(isAlphaCode(ac) || ac === 95 || ac === 58)) return -1; // _ or :
    j++;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (isAlphaCode(c) || isDigitCode(c) || c === 95 || c === 46 || c === 58 || c === 45) j++;
      else break;
    }
    let k = j;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    if (text[k] === '=') {
      k++;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      if (k >= n) return -1;
      const q = text[k];
      if (q === '"' || q === "'") {
        const endq = text.indexOf(q, k + 1);
        if (endq < 0) return -1;
        j = endq + 1;
      } else {
        let v = k;
        while (v < n) {
          const c = text[v];
          if (c === ' ' || c === '\t' || c === '\n' || c === '"' || c === "'" ||
              c === '=' || c === '<' || c === '>' || c === '`') break;
          v++;
        }
        if (v === k) return -1;
        j = v;
      }
    }
  }
}

/** 0 = no HTML block, otherwise { type: 1..7, tag } for the block's opener. */
function htmlBlockStart(line) {
  const indent = leadingCols(line);
  if (indent > 3) return 0;
  const s = dropColumns(line, indent);
  if (s[0] !== '<') return 0;
  if (s.startsWith('<!--')) return { type: 2 };
  if (s.startsWith('<?')) return { type: 3 };
  if (s.startsWith('<![CDATA[')) return { type: 5 };
  if (/^<![A-Z]/.test(s)) return { type: 4 };
  const m1 = /^<(script|pre|style|textarea)(?=[ \t>]|$)/i.exec(s);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  const tagEnd = scanHtmlTag(s, 0);
  if (tagEnd > 0 && /^[ \t]*$/.test(s.slice(tagEnd))) return { type: 7 };
  return 0;
}

function lexHtmlBlock(lines, i, end, start, tailTerminated) {
  const collected = [lines[i]];
  let j = i;
  if (start.type >= 1 && start.type <= 5) {
    let term;
    let from;
    if (start.type === 1) { term = '</' + start.tag; from = 1 + start.tag.length; }
    else if (start.type === 2) { term = '-->'; from = 4; }
    else if (start.type === 3) { term = '?>'; from = 2; }
    else if (start.type === 4) { term = '>'; from = 2; }
    else { term = ']]>'; from = 9; }
    const foundIn = (line, offset) =>
      start.type === 1
        ? line.toLowerCase().indexOf(term, offset) >= 0
        : line.indexOf(term, offset) >= 0;
    let done = foundIn(lines[i], from);
    while (!done && j + 1 < end) {
      j++;
      collected.push(lines[j]);
      done = foundIn(lines[j], 0);
    }
  } else {
    while (j + 1 < end && !isBlank(lines[j + 1])) {
      j++;
      collected.push(lines[j]);
    }
  }
  // marked keeps the newline that ends the block's last line. For the
  // terminator types (1-5) it is kept whenever a further line exists and
  // is not literally empty (a whitespace-only line still counts); for
  // the blank-line types (6-7) only at the very end of the input, and
  // only when the source's last line was newline-terminated.
  let text = collected.join('\n');
  const next = j + 1;
  const keepNl = start.type <= 5
    ? (next < end ? lines[next] !== '' : tailTerminated)
    : (next >= end && tailTerminated);
  if (keepNl) text += '\n';
  return { block: { type: 'html', text }, next };
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

/**
 * Try to read one link reference definition starting at lines[i].
 * Returns the number of source lines consumed (0 = not a definition).
 * On success the definition is registered in `defs` (first one wins).
 */
function tryParseDef(lines, i, end, defs) {
  const indent = leadingCols(lines[i]);
  if (indent > 3) return 0;
  const first = dropColumns(lines[i], indent);
  if (first[0] !== '[') return 0;
  let window = first;
  let windowLines = 1;
  while (windowLines < 6 && i + windowLines < end) {
    window += '\n' + lines[i + windowLines];
    windowLines++;
  }
  const n = window.length;
  let j = 1;
  let labelRaw = null;
  while (j < n) {
    const c = window[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(window[j + 1])) { j += 2; continue; }
    if (c === '[') return 0;
    if (c === ']') { labelRaw = window.slice(1, j); j++; break; }
    j++;
  }
  if (labelRaw === null || window[j] !== ':') return 0;
  j++;
  let newlines = 0;
  while (j < n) {
    const c = window[j];
    if (c === ' ' || c === '\t') j++;
    else if (c === '\n') { newlines++; j++; }
    else break;
  }
  if (newlines > 1) return 0;
  let href;
  if (window[j] === '<') {
    let k = j + 1;
    let out = '';
    let ok = false;
    while (k < n) {
      const c = window.charCodeAt(k);
      if (c === CC_LF) break;
      if (c === CC_BACKSLASH && k + 1 < n && isAsciiPunct(window[k + 1])) {
        out += window[k + 1];
        k += 2;
        continue;
      }
      if (c === CC_LT) break;
      if (c === CC_GT) { ok = true; break; }
      out += window[k];
      k++;
    }
    if (!ok) return 0;
    href = out;
    j = k + 1;
  } else {
    const d = scanBareDest(window, j);
    if (d.end === j) return 0;
    href = d.value;
    j = d.end;
  }
  let title = null;
  let endPos = -1;
  let k = j;
  while (k < n && (window[k] === ' ' || window[k] === '\t')) k++;
  if (k < n && window[k] !== '\n') {
    // Something follows the destination on its line: it must be a title
    // preceded by whitespace and followed only by whitespace.
    if (k > j && (window[k] === '"' || window[k] === "'" || window[k] === '(')) {
      const t = scanTitle(window, k);
      if (t) {
        let k2 = t.end;
        while (k2 < n && (window[k2] === ' ' || window[k2] === '\t')) k2++;
        if (k2 >= n || window[k2] === '\n') { title = t.value; endPos = k2; }
      }
    }
    if (endPos < 0) return 0;
  } else {
    // The destination line is finished; a title may sit alone on the
    // next line, otherwise the definition ends here.
    endPos = k;
    if (k < n && window[k] === '\n') {
      let k4 = k + 1;
      while (k4 < n && (window[k4] === ' ' || window[k4] === '\t')) k4++;
      if (window[k4] === '"' || window[k4] === "'" || window[k4] === '(') {
        const t = scanTitle(window, k4);
        if (t) {
          let k5 = t.end;
          while (k5 < n && (window[k5] === ' ' || window[k5] === '\t')) k5++;
          if (k5 >= n || window[k5] === '\n') { title = t.value; endPos = k5; }
        }
      }
    }
  }
  // a definition that runs to the end of the window is only complete when
  // the window really reaches the end of the input
  if (endPos >= n && i + windowLines < end) return 0;
  const label = normalizeLabel(labelRaw);
  if (!label) return 0;
  if (!defs.has(label)) defs.set(label, { href, title });
  let consumed = 1;
  for (let p = 0; p < endPos; p++) if (window[p] === '\n') consumed++;
  return consumed;
}

// ---------------------------------------------------------------------------
// Tables (GFM)
// ---------------------------------------------------------------------------

function splitRow(line) {
  const s = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  let start = 0;
  if (s[0] === '|') start = 1;
  let endIdx = s.length;
  if (endIdx > start && s[endIdx - 1] === '|') {
    let bs = 0;
    let k = endIdx - 2;
    while (k >= start && s[k] === '\\') { bs++; k--; }
    if (bs % 2 === 0) endIdx--;
  }
  const cells = [];
  let cur = '';
  for (let k = start; k < endIdx; k++) {
    const c = s[k];
    if (c === '\\' && k + 1 < endIdx) {
      const nx = s[k + 1];
      if (nx === '|') { cur += '|'; k++; continue; }
      if (nx === '\\') { cur += '\\'; k++; continue; }
      cur += c;
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  for (let c = 0; c < cells.length; c++) {
    cells[c] = cells[c].replace(/^[ \t]+|[ \t]+$/g, '');
  }
  return cells;
}

/** Alignment array for a delimiter row, or null when it is not one. */
function delimiterAligns(line) {
  const cells = splitRow(line);
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function isTableStart(lines, i, end) {
  if (i + 1 >= end) return false;
  if (lines[i + 1].indexOf('|') < 0) return false;
  const aligns = delimiterAligns(lines[i + 1]);
  if (!aligns) return false;
  return splitRow(lines[i]).length === aligns.length;
}

function parseTable(lines, i, end, inListItem = false) {
  const header = splitRow(lines[i]);
  const aligns = delimiterAligns(lines[i + 1]);
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const L = lines[j];
    // A line of only spaces and one trailing tab is not a blank line to
    // marked's table capture: it becomes a row of empty cells.
    const tabRow = /^ *\t$/.test(L);
    if (!tabRow && (isBlank(L) || leadingCols(L) >= 4 ||
        interruptsParagraph(L, inListItem))) break;
    const cells = splitRow(L);
    while (cells.length < header.length) cells.push('');
    if (cells.length > header.length) cells.length = header.length;
    rows.push(cells);
    j++;
  }
  return { block: { type: 'table', header, aligns, rows }, next: j };
}

// ---------------------------------------------------------------------------
// Paragraph collection and interruption rules
// ---------------------------------------------------------------------------

function interruptsParagraph(line, inListItem = false) {
  if (matchFenceStart(line)) return true;
  if (matchATX(line)) return true;
  if (isThematicBreak(line)) return true;
  if (startsBlockquote(line)) return true;
  const m = matchListMarker(line);
  if (m) {
    const info = markerInfo(m);
    // Inside a list item, marked lets an ordered list interrupt a
    // paragraph whatever its start number; elsewhere only 1 does.
    if (info.hasContent && (!m.ordered || m.num === 1 || inListItem)) return true;
  }
  const hb = htmlBlockStart(line);
  if (hb && hb.type >= 1 && hb.type <= 6) return true;
  return false;
}

/** Could `line` lazily continue a paragraph whose last line is `prevLine`? */
function isParaContinuation(prevLine, line, inListItem = false) {
  if (isBlank(line)) return false;
  if (setextLevel(line)) return false;
  if (line.indexOf('|') >= 0) {
    const aligns = delimiterAligns(line);
    if (aligns && splitRow(prevLine).length === aligns.length) return false;
  }
  return !interruptsParagraph(line, inListItem);
}

function collectParagraph(lines, i, end, inListItem = false) {
  const plines = [lines[i]];
  let j = i + 1;
  let headingLevel = 0;
  let tableAt = -1;
  // Inside a list item, a continuation line that still carries four or
  // more columns of indentation after the item dedent loses exactly
  // those four columns: the reference renderer's item capture folds
  // such a line into the paragraph as if its code-block prefix had
  // been consumed, while shallower lines keep their indentation. A run
  // of such deep lines is then separated from the rest of the paragraph
  // by an empty text line, the same artifact the blockquote capture
  // shows after a dedented lazy run.
  let afterDeep = false;
  const noteLine = (L, isDeep) => {
    if (afterDeep && !isDeep) plines.push('');
    afterDeep = isDeep;
  };
  const pushContinuation = (L) => {
    const deep = inListItem && leadingCols(L) >= 4;
    noteLine(L, deep);
    plines.push(deep ? dropColumns(L, 4) : L);
  };
  // A container may flag a line index in `gapBefore`: an empty text line
  // belongs in the paragraph just before that line (the blockquote lazy
  // capture inserts one after a run of dedented lazy lines). The flag is
  // honoured only when the line is actually taken as paragraph text.
  const gaps = lines.gapBefore;
  while (j < end) {
    const L = lines[j];
    if (isBlank(L)) break;
    if (lines.cont && lines.cont.has(j)) {
      // A line a container accepted as a lazy paragraph continuation: it
      // stays paragraph text even where it would otherwise interrupt or
      // convert (list marker, setext underline, table delimiter). The
      // container already settled its indentation; keep it as pushed.
      if (gaps && gaps.has(j)) plines.push('');
      noteLine(L, inListItem && leadingCols(L) >= 4);
      plines.push(L);
      j++;
      continue;
    }
    const su = setextLevel(L);
    if (su) { headingLevel = su; j++; break; }
    if (L.indexOf('|') >= 0) {
      const aligns = delimiterAligns(L);
      if (aligns && splitRow(plines[plines.length - 1]).length === aligns.length) {
        tableAt = j - 1;
        break;
      }
    }
    if (interruptsParagraph(L, inListItem)) break;
    if (gaps && gaps.has(j)) plines.push('');
    pushContinuation(L);
    j++;
  }
  return { plines, next: j, headingLevel, tableAt };
}

/** Does the block list end with an open paragraph? (lexes the lines) */
function endsInParagraph(lines, defs, inListItem = false) {
  if (lines.length === 0) return false;
  if (isBlank(lines[lines.length - 1])) return false;
  const bs = lexBlocks(lines, 0, lines.length, defs, true, null, inListItem);
  return blocksEndInParagraph(bs);
}

function blocksEndInParagraph(bs) {
  if (bs.length === 0) return false;
  const last = bs[bs.length - 1];
  if (last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return blocksEndInParagraph(last.children);
  if (last.type === 'list') {
    return last.items.length > 0 &&
      blocksEndInParagraph(last.items[last.items.length - 1]);
  }
  return false;
}

/**
 * Does the block list end inside a fenced code block that is still open
 * and already holds a non-blank content line? marked's list capture keeps
 * feeding lines to such a fence even when they lose their indentation.
 */
function blocksEndInOpenFence(blocks) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.type === 'code') {
    return last.closed === false && /[^ \t\n]/.test(last.text);
  }
  if (last.type === 'list') {
    return last.items.length > 0 &&
      blocksEndInOpenFence(last.items[last.items.length - 1]);
  }
  if (last.type === 'blockquote') return blocksEndInOpenFence(last.children);
  return false;
}

function linesEndInOpenFence(lines, defs, inListItem = false) {
  if (lines.length === 0) return false;
  return blocksEndInOpenFence(lexBlocks(lines, 0, lines.length, defs, true, null, inListItem));
}

// ---------------------------------------------------------------------------
// Containers: blockquotes and lists
// ---------------------------------------------------------------------------

function lexBlockquote(lines, i, end, defs, tailTerminated) {
  const inner = [];
  const cont = new Set();
  const gapBefore = new Set();
  inner.cont = cont;
  inner.gapBefore = gapBefore;
  let j = i;
  let prevLazy = false;
  // The reference renderer's lazy capture has two modes per paragraph,
  // decided by its first lazy line: a shallow first lazy line keeps
  // every lazy line of the paragraph verbatim, while a deep first lazy
  // line (four or more columns of indentation) dedents each deep lazy
  // line by four columns and slips an empty text line between the
  // dedented run and whatever follows it in the paragraph.
  let lazyDeep = null;
  let afterDeepRun = false;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    const indent = leadingCols(line);
    if (indent <= 3) {
      const deind = dropColumns(line, indent);
      if (deind[0] === '>') {
        let content = deind.slice(1);
        let consumed = 0;
        if (content[0] === ' ') { content = content.slice(1); consumed = 1; }
        else if (content[0] === '\t') {
          const w = 4 - ((indent + 1) % 4);
          content = ' '.repeat(Math.max(0, w - 1)) + content.slice(1);
          consumed = 1;
        }
        const pushed = rebaseLeading(content, indent + 1 + consumed);
        if (isBlank(pushed)) {
          // A blank content line ends the paragraph: the next lazy
          // line, if any, decides its capture mode afresh.
          lazyDeep = null;
          afterDeepRun = false;
        } else if (afterDeepRun) {
          gapBefore.add(inner.length);
          afterDeepRun = false;
        }
        inner.push(pushed);
        prevLazy = false;
        j++;
        continue;
      }
    }
    if (inner.length && endsInParagraph(inner, defs)) {
      const su = setextLevel(line);
      if (su && !isThematicBreak(line)) {
        // A setext underline can lazily continue the quote's paragraph,
        // but it stays paragraph text. When the previous line was itself
        // lazy, marked's capture shows it indented by four spaces.
        const stripped = line.replace(/^[ \t]+/, '');
        cont.add(inner.length);
        if (prevLazy) inner.push('    ' + stripped);
        else inner.push(stripped);
        prevLazy = true;
        j++;
        continue;
      }
      if (isParaContinuation(inner[inner.length - 1], line)) {
        cont.add(inner.length);
        const cols = leadingCols(line);
        if (lazyDeep === null) lazyDeep = cols >= 4;
        if (lazyDeep && cols >= 4) {
          // Deep lazy line in a deep-started paragraph: dedent by the
          // four-column prefix and remember the run is open.
          inner.push(dropColumns(line, 4));
          afterDeepRun = true;
        } else if (lazyDeep && afterDeepRun) {
          // A shallow lazy line right after a dedented run closes the
          // run: the empty text line goes in front of it.
          gapBefore.add(inner.length);
          afterDeepRun = false;
          inner.push(line);
        } else {
          // Shallow-started paragraph: lazy lines are captured
          // verbatim, whatever indentation they carry.
          inner.push(line);
        }
        prevLazy = true;
        j++;
        continue;
      }
    }
    break;
  }
  // A whitespace-only content line at the very end of the quote is kept
  // as paragraph text (marked's capture ends there), though anywhere
  // else it separates blocks: > foo / > ␣␣ renders foo\n␣ in the <p>.
  let tailWs = null;
  if (inner.length >= 2) {
    const lastInner = inner[inner.length - 1];
    if (lastInner.length > 0 && isBlank(lastInner) &&
        !isBlank(inner[inner.length - 2])) {
      tailWs = lastInner;
      inner.pop();
    }
  }
  const children = lexBlocks(inner, 0, inner.length, defs, false);
  if (tailWs !== null && children.length > 0 &&
      children[children.length - 1].type === 'paragraph') {
    children[children.length - 1].text += '\n' + tailWs;
  }
  return { block: { type: 'blockquote', children }, next: j };
}

function lexList(lines, i, end, defs, firstMarker, tailTerminated) {
  const ordered = firstMarker.ordered;
  const delim = firstMarker.delim;
  const items = [];
  let loose = false;
  let j = i;
  while (j < end) {
    const m = matchListMarker(lines[j]);
    if (!m || m.ordered !== ordered || m.delim !== delim) break;
    const contentIndent = markerInfo(m).contentIndent;
    const itemLines = [
      dropColumns(
        rebaseLeading(m.deind.slice(m.markerLen), m.markerEndCol),
        contentIndent - m.markerEndCol),
    ];
    const itemCont = new Set();
    itemLines.cont = itemCont;
    let hadContent = !isBlank(itemLines[0]);
    let blanks = 0;
    j++;
    let sibling = false;
    let listDone = false;
    while (j < end) {
      const L = lines[j];
      if (isBlank(L)) {
        if (!hadContent) {
          // An item that starts with a blank line and is still empty ends
          // at the blank line; the list only continues if a sibling item
          // marker follows the blank run.
          let k = j;
          while (k < end && isBlank(lines[k])) k++;
          const nm = k < end ? matchListMarker(lines[k]) : null;
          if (nm && nm.ordered === ordered && nm.delim === delim) {
            loose = true;
            sibling = true;
            j = k;
          } else {
            listDone = true;
          }
          break;
        }
        blanks++; j++; continue;
      }
      const ind = leadingCols(L);
      if (ind >= contentIndent) {
        if (blanks > 0) {
          for (let b = 0; b < blanks; b++) itemLines.push('');
          blanks = 0;
        }
        itemLines.push(rebaseLeading(dropColumns(L, contentIndent), contentIndent));
        hadContent = true;
        j++;
        continue;
      }
      if (isThematicBreak(L)) { listDone = true; break; }
      const mm = matchListMarker(L);
      if (mm) {
        if (mm.ordered === ordered && mm.delim === delim) {
          if (blanks > 0) loose = true;
          sibling = true;
        } else {
          listDone = true;
        }
        break;
      }
      if (blanks === 0 && linesEndInOpenFence(itemLines, defs, true) &&
          !interruptsParagraph(L, true)) {
        itemLines.push(rebaseLeading(dropColumns(L, contentIndent), contentIndent));
        hadContent = true;
        j++;
        continue;
      }
      if (blanks === 0 && endsInParagraph(itemLines, defs, true)) {
        const su = setextLevel(L);
        if (su && !isThematicBreak(L)) {
          // A setext underline lazily continues the item's paragraph as
          // plain text; it does not become a heading inside the item.
          itemCont.add(itemLines.length);
          itemLines.push(L.replace(/^[ \t]+/, ''));
          j++;
          continue;
        }
        if (isParaContinuation(itemLines[itemLines.length - 1], L, true)) {
          itemCont.add(itemLines.length);
          itemLines.push(leadingCols(L) >= 4 ? L.replace(/^[ \t]+/, '') : L);
          j++;
          continue;
        }
      }
      listDone = true;
      break;
    }
    const itemSpans = [];
    const itemBlocks = lexBlocks(itemLines, 0, itemLines.length, defs, false, itemSpans, true);
    // The list is loose when two blocks of one item are separated by a
    // blank line (blank lines inside a single block, e.g. a fence, and
    // blank lines inside nested items do not count at this level).
    for (let b = 1; b < itemSpans.length && !loose; b++) {
      for (let g = itemSpans[b - 1][1]; g < itemSpans[b][0]; g++) {
        if (isBlank(itemLines[g])) { loose = true; break; }
      }
    }
    items.push(itemBlocks);
    if (listDone || !sibling) break;
  }
  return {
    block: { type: 'list', ordered, start: firstMarker.num, loose, items },
    next: j,
  };
}

// ---------------------------------------------------------------------------
// The block lexer
// ---------------------------------------------------------------------------

/**
 * Consume the body of a fenced code block whose opening fence sits just
 * before `start`. Returns the content lines, the index just past the
 * closing fence (or `end` when the fence never closes), and whether a
 * closing fence was found.
 *
 * The two fence flavours treat content indentation differently, matching
 * the reference renderer byte for byte:
 *  - A backtick fence sheds its own indentation: every content line loses
 *    up to `fence.indent` leading whitespace characters (dropFenceIndent).
 *  - A tilde fence keeps its content verbatim — no indentation is removed
 *    from any line, however deep the fence itself is indented.
 * A closing fence is a line under at most 3 columns of indentation whose
 * text is a run of the fence character at least as long as the opening
 * run, followed by nothing but spaces and tabs.
 */
function scanFenceBody(lines, start, end, fence) {
  const content = [];
  const dedent = fence.ch === '`';
  let j = start;
  while (j < end) {
    const L = lines[j];
    const ind = leadingCols(L);
    if (ind <= 3) {
      const s = dropColumns(L, ind);
      let run = 0;
      while (run < s.length && s[run] === fence.ch) run++;
      if (run >= fence.len && /^[ \t]*$/.test(s.slice(run))) {
        return { content, next: j + 1, closed: true };
      }
    }
    content.push(dedent ? dropFenceIndent(L, fence.indent) : L);
    j++;
  }
  return { content, next: j, closed: false };
}

function lexBlocks(lines, start, end, defs, tailTerminated, spans, inListItem = false) {
  const blocks = [];
  let i = start;
  // Push a block that starts at line i and consumes up to `next`; when
  // spans are being collected, record [startLine, endLine) with trailing
  // blank lines trimmed (blank lines are separators, not block content).
  const emit = (block, next) => {
    if (spans) {
      let e = next;
      while (e > i && isBlank(lines[e - 1])) e--;
      spans.push([i, e]);
    }
    blocks.push(block);
    i = next;
  };
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const indent = leadingCols(line);
    if (indent >= 4) {
      const clines = [];
      let j = i;
      while (j < end) {
        const L = lines[j];
        if (isBlank(L)) { clines.push(dropColumns(L, 4)); j++; continue; }
        if (leadingCols(L) >= 4) { clines.push(dropColumns(L, 4)); j++; continue; }
        break;
      }
      while (clines.length && isBlank(clines[clines.length - 1])) clines.pop();
      emit({ type: 'code', lang: null, text: clines.join('\n') + '\n' }, j);
      continue;
    }
    const fence = matchFenceStart(line);
    if (fence) {
      const body = scanFenceBody(lines, i + 1, end, fence);
      const content = body.content;
      const closed = body.closed;
      const j = body.next;
      const joined = content.join('\n');
      const text = joined === '' ? '' : joined.endsWith('\n') ? joined : joined + '\n';
      const lang = fence.info ? unescapePunct(fence.info.split(/[ \t]+/)[0]) : null;
      emit({ type: 'code', lang, text, closed }, j);
      continue;
    }
    const atx = matchATX(line);
    if (atx) {
      emit({ type: 'heading', level: atx.level, text: atx.text }, i + 1);
      continue;
    }
    if (isThematicBreak(line)) {
      emit({ type: 'hr' }, i + 1);
      continue;
    }
    if (startsBlockquote(line)) {
      const r = lexBlockquote(lines, i, end, defs, tailTerminated);
      emit(r.block, r.next);
      continue;
    }
    const lm = matchListMarker(line);
    if (lm) {
      const r = lexList(lines, i, end, defs, lm, tailTerminated);
      emit(r.block, r.next);
      continue;
    }
    const hb = htmlBlockStart(line);
    if (hb) {
      const r = lexHtmlBlock(lines, i, end, hb, tailTerminated);
      emit(r.block, r.next);
      continue;
    }
    if (dropColumns(line, indent)[0] === '[') {
      const used = tryParseDef(lines, i, end, defs);
      if (used > 0) {
        // Definitions produce no output, but for list-looseness purposes
        // they still count as a block separated by blank lines.
        if (spans) emit({ type: 'def' }, i + used);
        else i += used;
        continue;
      }
    }
    if (isTableStart(lines, i, end)) {
      const r = parseTable(lines, i, end, inListItem);
      emit(r.block, r.next);
      continue;
    }
    const p = collectParagraph(lines, i, end, inListItem);
    if (p.tableAt >= 0) {
      const head = p.plines.slice(0, -1);
      if (head.length) emit({ type: 'paragraph', text: head.join('\n') }, p.tableAt);
      const r = parseTable(lines, p.tableAt, end, inListItem);
      emit(r.block, r.next);
      continue;
    }
    if (p.headingLevel) {
      const text = p.plines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      emit({ type: 'heading', level: p.headingLevel, text }, p.next);
      continue;
    }
    emit({ type: 'paragraph', text: p.plines.join('\n') }, p.next);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing. The scanner produces a node list; emphasis is resolved
// with a delimiter stack, links/images with a bracket stack (the standard
// CommonMark strategy). Entities and GFM autolinks are handled when text
// nodes render, so decoded characters are never re-scanned as markup.
// ---------------------------------------------------------------------------

function flanking(text, i, len) {
  const prevCh = i > 0 ? text[i - 1] : '\n';
  const nextCh = i + len < text.length ? text[i + len] : '\n';
  const prevWs = isWsCh(prevCh);
  const nextWs = isWsCh(nextCh);
  const prevPunct = isPunctCh(prevCh);
  const nextPunct = isPunctCh(nextCh);
  return {
    left: !nextWs && (!nextPunct || prevWs || prevPunct),
    right: !prevWs && (!prevPunct || nextWs || nextPunct),
    prevPunct,
    nextPunct,
  };
}

// Emphasis matching. Marked's observable behavior matches the CommonMark
// delimiter-stack algorithm plus three refinements, all established by
// black-box probing:
//  (1) After a both-flanking run has been consumed as a closer (the tail of
//      an intraword pair like *so*), a later closer is blocked from matching
//      a longer opener when the pair's lengths sum to a multiple of 3.
//  (2) A 2/2 match is blocked when the closer stands in the "shadow" of such
//      a consumed both-flanking closer: the same-char run right before it is
//      that closer, or is a closer whose own opener directly followed it.
//  (3) When a strong match forms over a span containing such a consumed
//      both-flanking closer, the closer run's excess characters render
//      inside the strong element instead of after it.
function processEmphasis(nodes, delimStack, bottom) {
  const snap = delimStack.slice();
  const snapIdx = new Map(snap.map((d, idx) => [d, idx]));
  const betweenOf = (op, cl) => {
    const a = snapIdx.get(op);
    const b = snapIdx.get(cl);
    if (a === undefined || b === undefined || b - a < 2) return [];
    return snap.slice(a + 1, b);
  };
  const prevSameChar = (d) => {
    const idx = snapIdx.get(d);
    if (idx === undefined) return null;
    for (let k = idx - 1; k >= 0; k--) {
      // Runs that can neither open nor close are plain text, not delimiters.
      if (snap[k].ch === d.ch && (snap[k].canOpen || snap[k].canClose)) {
        return snap[k];
      }
    }
    return null;
  };
  // A run casts a shadow when it was consumed as a closer in a match where
  // it was a length-1 both-flanking run whose opener was not itself
  // both-flanking (an intraword pair like *so* glued after a word or space,
  // not a both/both pair like *b* in a*b*c, and not a ** run).
  const isBothCloser = (d) => !!(d && d.shadowCaster);
  const shadowed = (cl) => {
    const r = prevSameChar(cl);
    if (!r) return false;
    if (isBothCloser(r)) return true;
    if (r.usedAsCloser && r.matchOpener) {
      return isBothCloser(prevSameChar(r.matchOpener));
    }
    return false;
  };
  // Is there an earlier still-open run of the same char and length >= 2
  // below this one? The shadowed-opener block applies only when skipping
  // the opener lets the closer reach such an outer opener (**a *b*other
  // **c**); a fresh intraword pair after a closed em (…*a* b**c**d) is
  // not blocked.
  const hasOuterOpener = (op) => {
    const idx = snapIdx.get(op);
    if (idx === undefined) return false;
    for (let k = idx - 1; k >= 0; k--) {
      const d = snap[k];
      if (d.ch === op.ch && d.len >= 2 && d.canOpen) return true;
    }
    return false;
  };
  // The span block, on its own: a use-1 match may not span a
  // both-flanking run of length >= 2 that already closed a strong:
  // *a **b**c* keeps the outer stars literal. It does not apply when
  // that strong's opener is the candidate opener itself (***a**b*) or
  // is itself both-flanking (*a**b**c*), nor once the opener has had a
  // closer refused by this very rule (see the skip in the main loop).
  const spanBlocked = (op, closer) => {
    if (op.noSpanBlock) return false;
    if (op.len >= 2 && closer.len >= 2) return false;
    return betweenOf(op, closer).some((d) => d.ch === closer.ch &&
      d.origLen >= 2 && d.canOpen && d.canClose &&
      d.usedAsCloser && d.matchUse === 2 &&
      d.matchOpener !== op &&
      !(d.matchOpener && d.matchOpener.canOpen && d.matchOpener.canClose));
  };
  // Returns 0 when the pair may match, 1 when the rule of three blocks
  // it, 2 when a shadow rule blocks it.
  const emphBlocked = (op, closer) => {
    if ((closer.canOpen || op.canClose) &&
        (op.len + closer.len) % 3 === 0 &&
        !(op.len % 3 === 0 && closer.len % 3 === 0)) return 1;
    if (closer.ch === '~') return 0;
    if (op.len === 2 && closer.len === 2 &&
        (shadowed(closer) ||
         (op.canOpen && op.canClose && shadowed(op) && hasOuterOpener(op)))) return 2;
    if (spanBlocked(op, closer)) {
      return 2;
    }
    const between = betweenOf(op, closer);
    const hasBoth = between.some(
      (d) => d.ch === closer.ch && isBothCloser(d));
    if (!hasBoth) return 0;
    if (op.len > closer.len &&
        (op.len + closer.len) % 3 === 0 &&
        !(op.len % 3 === 0 && closer.len % 3 === 0)) return 1;
    return 0;
  };
  let scanFrom = bottom;
  while (true) {
    let ci = -1;
    for (let k = scanFrom; k < delimStack.length; k++) {
      if (delimStack[k].canClose) { ci = k; break; }
    }
    if (ci < 0) return;
    const closer = delimStack[ci];
    let oi = -1;
    let examined = false;
    for (let k = ci - 1; k >= bottom; k--) {
      const op = delimStack[k];
      if (op.ch !== closer.ch || !op.canOpen) continue;
      if (closer.ch === '~' && op.len !== closer.len) continue;
      const block = emphBlocked(op, closer);
      if (block) {
        // Span-block skip: a length-1 closer refused by the span rule
        // against its nearest opener does not simply die when a whole
        // intraword pair follows it — the reference renderer closes the
        // opener at the pair's far star instead, leaving this closer
        // and the pair's near star as literal text inside the emphasis
        // (*a **b**c* d*e*f is one big em, not literal stars + *e*).
        // Retire both runs and lift the span block for this opener so
        // the far star can match it when its turn comes.
        if (!examined && block === 2 && closer.len === 1 && op.len === 1 &&
            spanBlocked(op, closer)) {
          let pairNear = null;
          let pairFar = null;
          for (let m = ci + 1; m < delimStack.length; m++) {
            const d = delimStack[m];
            if (d.ch !== closer.ch || d.len === 0) continue;
            if (!pairNear) { pairNear = d; continue; }
            pairFar = d;
            break;
          }
          if (pairNear && pairFar &&
              pairNear.len === 1 && pairNear.canOpen && pairNear.canClose &&
              pairFar.len === 1 && pairFar.canClose) {
            closer.canOpen = false;
            closer.canClose = false;
            pairNear.canOpen = false;
            pairNear.canClose = false;
            op.noSpanBlock = true;
            break;
          }
        }
        // A both-flanking closer of length 1 whose nearest opener is
        // refused by the rule of three does not look further down the
        // stack: it stays available as an opener for a later closer
        // (*a **b*c* d). A length-2 closer does fall through (x**y*z**w).
        if (!examined && block === 1 && closer.len === 1 &&
            closer.canOpen && closer.canClose) {
          break;
        }
        examined = true;
        continue;
      }
      oi = k;
      break;
    }
    if (oi < 0) {
      // No opener for this closer in range. Keep it on the stack: a later
      // pass with a lower bottom may still match it (e.g. emphasis that
      // spans a failed link's brackets).
      scanFrom = ci + 1;
      continue;
    }
    const opener = delimStack[oi];
    const use = closer.ch === '~' ? opener.len
      : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const nodeIdxO = nodes.indexOf(opener);
    const nodeIdxC = nodes.indexOf(closer);
    const children = nodes.slice(nodeIdxO + 1, nodeIdxC);
    // Refinement (3): excess of the closer run renders inside the strong.
    let consumeCloser = use;
    if (use === 2 && closer.len > use && opener.len === opener.origLen &&
        betweenOf(opener, closer).some(
          (d) => d.ch === closer.ch && isBothCloser(d))) {
      children.push({ t: 'text', s: closer.ch.repeat(closer.len - use) });
      consumeCloser = closer.len;
    }
    const closerLenAtMatch = closer.len;
    opener.len -= use;
    closer.len -= consumeCloser;
    closer.usedAsCloser = true;
    closer.matchOpener = opener;
    closer.matchUse = use;
    if (closerLenAtMatch === 1 && closer.canOpen && closer.canClose &&
        !(opener.canOpen && opener.canClose)) {
      closer.shadowCaster = true;
    }
    const wrap = {
      t: closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em',
      children,
    };
    const seg = [];
    if (opener.len > 0) seg.push(opener);
    seg.push(wrap);
    if (closer.len > 0) seg.push(closer);
    nodes.splice(nodeIdxO, nodeIdxC - nodeIdxO + 1, ...seg);
    const nd = [];
    for (let k = 0; k < delimStack.length; k++) {
      const d = delimStack[k];
      if (k > oi && k < ci) continue;
      if (d === opener && opener.len === 0) continue;
      if (d === closer && closer.len === 0) continue;
      nd.push(d);
    }
    delimStack.length = 0;
    for (const d of nd) delimStack.push(d);
    scanFrom = bottom;
  }
}

/** Scan a reference label starting just after `[`. Null when invalid. */
function scanRefLabel(text, pos) {
  const n = text.length;
  let j = pos;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { raw: text.slice(pos, j), end: j + 1 };
    j++;
  }
  return null;
}

const EMAIL_FULL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * marked tracks whether the output is currently inside a raw `<a>` element:
 * while it is, BARE autolinks are not formed (angle-bracket autolinks still
 * are). The state spans blocks for the whole document. The state is set
 * only by a start tag of the form `<a ...` with a literal space after the
 * tag name (so `<a>`, `<a/>`, and `<a\thref>` do not set it, but
 * `<a href="x"/>` does). Returns the new state after an HTML fragment.
 */
function anchorStateAfter(html, state) {
  if (/^<\/a(?=[\s>])/i.test(html)) return false;
  if (/^<a /i.test(html)) return true;
  return state;
}

/** Start of the first backtick run of exactly `run` in text before limit. */
function findCodeClose(text, from, run, limit) {
  const n = Math.min(text.length, limit);
  let j = from;
  while (j < n) {
    if (text[j] === '`') {
      let r = 0;
      while (j + r < n && text[j + r] === '`') r++;
      if (r === run) return j;
      j += r;
    } else j++;
  }
  return -1;
}

/** The `]` closing the innermost open bracket, scanning from `from`. */
function findBracketClose(text, from) {
  const n = text.length;
  let depth = 0;
  let j = from;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) { j += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return -1;
}

/** Would a link (inline, full/collapsed ref, or shortcut) form at cp? */
function linkFormsAt(text, bracket, cp, defs) {
  const label = text.slice(bracket.srcStart, cp);
  if (labelBlocksLink(label)) return false;
  if (text[cp + 1] === '(') {
    if (parseLinkParens(text, cp + 2)) return true;
  } else if (text[cp + 1] === '[') {
    const lab = scanRefLabel(text, cp + 2);
    if (lab) {
      const rawLabel = lab.raw === '' ? label : lab.raw;
      return !!defs.get(normalizeLabel(rawLabel));
    }
    return false;
  }
  return !!defs.get(normalizeLabel(label));
}

/**
 * Marked decides emphasis over a copy of the inline text in which code
 * spans are masked out, and the masking pairs backtick runs across the
 * whole paragraph — even runs sitting inside link labels. A delimiter
 * run inside a masked range is inert. The ranges use plain code-span
 * pairing (a run closes at the next run of equal length), computed
 * independently of how links and spans actually tokenize.
 */
function computeCodeMasks(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      const close = findCodeClose(text, i + run, run, n);
      if (close >= 0) { ranges.push([i, close + run]); i = close + run; continue; }
      i += run;
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * Backtick-fence content dedent (tilde fences keep content verbatim; see
 * scanFenceBody): a content line loses up to `indent` leading whitespace
 * CHARACTERS — a tab counts as one character, not four columns (``` at
 * indent 1 turns a leading tab into nothing, while one leading space in
 * front of the tab shields it).
 */
function dropFenceIndent(line, indent) {
  let i = 0;
  while (i < indent && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

/** Cheap prefix test for a URL-type autolink at s[p] (www. or a
 * scheme:// head), so the full matcher only runs where a URL can
 * actually start — most w/h/f letters begin ordinary words. */
function urlPrefixAt(s, p) {
  const c = s[p];
  if (c === 'w') return s.startsWith('www.', p);
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
    const tail = s.slice(p, p + 8).toLowerCase();
    return tail.startsWith('http://') || tail.startsWith('https://') ||
      tail.startsWith('ftp://');
  }
  return false;
}

/** True when the source span [from, to) holds a URL-type autolink
 * candidate outside any code-span mask. Used to decide whether a
 * failed bracket's span must be rescanned as ordinary text. */
function labelHasUrl(text, from, to, inMask) {
  for (let p = from; p < to; p++) {
    const ch = text[p];
    if (ch !== 'w' && ch !== 'h' && ch !== 'H' && ch !== 'f' && ch !== 'F') continue;
    if (!urlPrefixAt(text, p)) continue;
    if (inMask(p)) continue;
    if (matchUrlAutolink(text, p)) return true;
  }
  return false;
}

function parseInline(text, ctx) {
  const defs = ctx.defs;
  let rawAnchor = ctx.inRawAnchor;
  // Index until which emphasis delimiters are dead (a failed link's
  // (...) group renders with emphasis suppressed).
  let deadUntil = -1;
  const nodes = [];
  const delimStack = [];
  const bracketStack = [];
  // Count of currently active brackets, maintained alongside the stack
  // (the scan-time autolink rule needs it per character).
  let activeBrackets = 0;
  const n = text.length;
  const masks = text.indexOf('`') >= 0 ? computeCodeMasks(text) : null;
  const inMask = masks
    ? (pos) => {
        for (const [a, b] of masks) {
          if (pos < a) return false;
          if (pos < b) return true;
        }
        return false;
      }
    : () => false;
  let buf = '';
  let i = 0;
  const flushText = () => {
    if (buf) { nodes.push({ t: 'text', s: buf }); buf = ''; }
  };
  while (i < n) {
    const c = text[i];
    // URL-type bare autolinks are recognised here, at scan time: the
    // reference tokenizer commits to the URL at its first character, so
    // brackets, delimiters and backticks inside it never become markup.
    // The rule applies inside a failed link's paren group too (only its
    // delimiters are dead there, not its text), but not inside an open
    // bracket, a code-span mask, or a raw <a> element.
    if ((c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F') &&
        activeBrackets === 0 && !rawAnchor && !inMask(i) && urlPrefixAt(text, i)) {
      const a = matchUrlAutolink(text, i);
      if (a) {
        flushText();
        nodes.push({ t: 'autolink', href: a.href, text: a.text, bare: true });
        i = a.end;
        continue;
      }
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx !== undefined && isAsciiPunct(nx)) {
        // An escaped character is literal text: it must not be seen by the
        // entity or autolink logic, so it gets its own node.
        flushText();
        nodes.push({ t: 'text', s: nx, esc: true });
        i += 2;
        continue;
      }
      if (nx === '\n') {
        // A backslash at the end of a bare autolink is swallowed by the
        // link (www.flux.com\ renders with %5C in the href), and the line
        // break stays soft; only otherwise is it a hard break.
        if (bufEndsWithAutolink(buf)) {
          buf += '\\';
          i++;
          continue;
        }
        flushText();
        nodes.push({ t: 'br' });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flushText();
        nodes.push({ t: 'br' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      buf += '\n';
      i++;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      let closeStart = findCodeClose(text, i + run, run, n);
      if (bracketStack.length) {
        // Inside a bracket, marked matches the link before any code
        // span: a span whose closing run lies past the bracket's `]`
        // does not form when a link results at that bracket.
        const top = bracketStack[bracketStack.length - 1];
        const cp = findBracketClose(text, i);
        if (cp > 0 && (closeStart < 0 || closeStart > cp) &&
            findCodeClose(text, i + run, run, cp) < 0 &&
            linkFormsAt(text, top, cp, defs)) {
          buf += text.slice(i, i + run);
          i += run;
          continue;
        }
      }
      if (closeStart < 0) { buf += text.slice(i, i + run); i += run; continue; }
      let content = text.slice(i + run, closeStart).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' &&
          content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ t: 'code', s: content });
      i = closeStart + run;
      continue;
    }
    if (c === '<') {
      let done = false;
      const j = i + 1;
      if (j < n && isAlphaCode(text.charCodeAt(j))) {
        let k = j + 1;
        while (k < n) {
          const cc = text.charCodeAt(k);
          if (isAlphaCode(cc) || isDigitCode(cc) || cc === 43 || cc === 45 || cc === 46) k++;
          else break;
        }
        if (k - j >= 2 && k - j <= 32 && text[k] === ':') {
          let e = k + 1;
          while (e < n && text[e] !== '>' && text[e] !== '<' && !isWsCh(text[e])) e++;
          if (text[e] === '>' && e > k + 1) {
            flushText();
            const url = text.slice(i + 1, e);
            nodes.push({ t: 'autolink', href: url, text: url });
            i = e + 1;
            done = true;
          }
        }
      }
      if (!done) {
        const gt = text.indexOf('>', i + 1);
        if (gt > i + 1 && gt - i < 2000) {
          const inner = text.slice(i + 1, gt);
          if (inner.indexOf('<') < 0 && EMAIL_FULL_RE.test(inner)) {
            flushText();
            nodes.push({ t: 'autolink', href: 'mailto:' + inner, text: inner });
            i = gt + 1;
            done = true;
          }
        }
      }
      if (!done) {
        const tagEnd = scanHtmlTag(text, i);
        if (tagEnd > 0) {
          flushText();
          const raw = text.slice(i, tagEnd);
          rawAnchor = anchorStateAfter(raw, rawAnchor);
          nodes.push({ t: 'html', s: raw });
          i = tagEnd;
          done = true;
        }
      }
      if (!done) { buf += '<'; i++; }
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      flushText();
      const node = { t: 'text', s: '![' };
      nodes.push(node);
      bracketStack.push({
        node, isImage: true, delimLen: delimStack.length, active: true, srcStart: i + 2,
      });
      activeBrackets++;
      i += 2;
      continue;
    }
    if (c === '[') {
      flushText();
      const node = { t: 'text', s: '[' };
      nodes.push(node);
      bracketStack.push({
        node, isImage: false, delimLen: delimStack.length, active: true, srcStart: i + 1,
      });
      activeBrackets++;
      i += 1;
      continue;
    }
    if (c === ']') {
      const bracket = bracketStack[bracketStack.length - 1];
      if (!bracket || !bracket.active) {
        if (bracket) {
          bracketStack.pop();
          // An inactive bracket (a nested link already claimed the
          // span) is plain text for the reference renderer: when its
          // label holds a bare URL, rescan the label with the bracket
          // gone so the URL rule can commit across what follows,
          // exactly as on the active fail path below.
          if (labelHasUrl(text, bracket.srcStart, i, inMask)) {
            const bIdx = nodes.indexOf(bracket.node);
            if (bIdx >= 0) {
              nodes.length = bIdx + 1;
              delimStack.length = bracket.delimLen;
              if (deadUntil <= i) deadUntil = -1;
              buf = '';
              i = bracket.srcStart;
              continue;
            }
          }
        }
        buf += ']';
        i++;
        continue;
      }
      // The link outcome is decided before emphasis runs: when a complete
      // (...) group follows the bracket but no link results, marked
      // renders the whole span with emphasis suppressed.
      let link = null;
      let consumedEnd = -1;
      let refBlocked = false;
      let parenFailed = false;
      let parenEnd = -1;
      const labelText = text.slice(bracket.srcStart, i);
      const labelBad = labelBlocksLink(labelText);
      if (text[i + 1] === '(') {
        const p = parseLinkParens(text, i + 2);
        if (p && !labelBad) {
          link = p;
          consumedEnd = p.end;
        } else {
          const gEnd = scanParenGroupEnd(text, i + 1);
          if (gEnd > 0) { parenFailed = true; parenEnd = gEnd; }
        }
      }
      if (!link && !labelBad && text[i + 1] === '[') {
        const lab = scanRefLabel(text, i + 2);
        if (lab) {
          refBlocked = true;
          const rawLabel = lab.raw === '' ? text.slice(bracket.srcStart, i) : lab.raw;
          const def = defs.get(normalizeLabel(rawLabel));
          if (def) { link = def; consumedEnd = lab.end; }
        }
      }
      if (!link && !labelBad && !refBlocked) {
        const def = defs.get(normalizeLabel(text.slice(bracket.srcStart, i)));
        if (def) { link = def; consumedEnd = i + 1; }
      }
      bracketStack.pop();
      activeBrackets--;
      if (!link && parenFailed) {
        // The label's delimiters leave the stack unprocessed, so they
        // render as literal runs and later closers cannot reach them;
        // the (...) group is scanned with its delimiters dead too.
        delimStack.length = bracket.delimLen;
        buf += ']';
        deadUntil = parenEnd;
        i = i + 1;
        continue;
      }
      if (!link && !labelBad && labelHasUrl(text, bracket.srcStart, i, inMask)) {
        // When a bracket fails, the reference tokenizer falls back to
        // scanning the label as ordinary text — and a bare URL inside
        // it then commits at its first character and runs past the
        // bracket's own `]` and whatever follows. The nodes built for
        // the label cannot express that (they were split at every
        // bracket and delimiter), so discard them and rescan the label
        // text in place with this bracket gone.
        const bIdx = nodes.indexOf(bracket.node);
        if (bIdx >= 0) {
          nodes.length = bIdx + 1;
          delimStack.length = bracket.delimLen;
          if (deadUntil <= i) deadUntil = -1;
          buf = '';
          i = bracket.srcStart;
          continue;
        }
      }
      processEmphasis(nodes, delimStack, bracket.delimLen);
      if (link) {
        flushText();
        const bIdx = nodes.indexOf(bracket.node);
        const children = nodes.splice(bIdx + 1);
        nodes.pop();
        nodes.push({
          t: bracket.isImage ? 'image' : 'link',
          href: link.href,
          title: link.title,
          children,
        });
        delimStack.length = bracket.delimLen;
        if (!bracket.isImage) {
          for (const b of bracketStack) {
            if (!b.isImage && b.active) { b.active = false; activeBrackets--; }
          }
        }
        i = consumedEnd;
        continue;
      }
      buf += ']';
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (i + run < n && text[i + run] === c) run++;
      if (i < deadUntil) { buf += text.slice(i, i + run); i += run; continue; }
      if (inMask(i) && bracketStack.length === 0) { buf += text.slice(i, i + run); i += run; continue; }
      if (c === '~' && run >= 3) { buf += text.slice(i, i + run); i += run; continue; }
      const fl = flanking(text, i, run);
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = fl.left && (!fl.right || fl.prevPunct);
        canClose = fl.right && (!fl.left || fl.nextPunct);
      } else {
        canOpen = fl.left;
        canClose = fl.right;
      }
      if (!canOpen && !canClose) {
        // A run that can neither open nor close is plain text; keeping it
        // in the text buffer lets autolink detection see across it.
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      flushText();
      const node = { t: 'delim', ch: c, len: run, origLen: run, canOpen, canClose };
      nodes.push(node);
      delimStack.push(node);
      i += run;
      continue;
    }
    buf += c;
    i++;
  }
  flushText();
  processEmphasis(nodes, delimStack, 0);
  return nodes;
}

// ---------------------------------------------------------------------------
// Text rendering: entity handling and GFM bare autolinks
// ---------------------------------------------------------------------------

const NUM_DEC_RE = /&#(\d{1,7});/y;
const NUM_HEX_RE = /&#[xX]([0-9a-fA-F]{1,6});/y;
const NAMED_ENT_RE = /&(\w+);/y;
const BARE_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]+/y;
const EMAIL_PREV_BLOCK_RE = /[A-Za-z0-9._%+-@]/;

/** Index just past the `)` closing the group opened at text[openIdx], or -1. */
function scanParenGroupEnd(text, openIdx) {
  const n = text.length;
  let depth = 0;
  let j = openIdx;
  let atDestStart = true;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { j += 2; atDestStart = false; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      j++;
      while (j < n && text[j] !== q) { if (text[j] === '\\') j++; j++; }
      j++;
      atDestStart = false;
      continue;
    }
    if (c === '<' && atDestStart) {
      // A pointy destination may itself contain parentheses; skip it
      // when it closes on the same line.
      const gt = text.indexOf('>', j + 1);
      const nl = text.indexOf('\n', j + 1);
      if (gt > 0 && (nl < 0 || gt < nl)) { j = gt + 1; atDestStart = false; continue; }
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j + 1; }
    if (c !== ' ' && c !== '\t' && c !== '\n') atDestStart = false;
    j++;
  }
  return -1;
}

/**
 * Scan a link label's backtick runs the way marked's link pattern does.
 * A run opens a span: following runs shorter than it are content, a run
 * of the same length closes it, a longer run breaks it. A run with no
 * clean close pairs loosely with the next run; a run with no next run
 * at all invalidates the label ([a `b](x) stays literal). Returns the
 * list of true code spans found, each flagged dirty when its content
 * contains a backtick.
 */
function scanLabelBackticks(label) {
  const n = label.length;
  const spans = [];
  let valid = true;
  let i = 0;
  while (i < n) {
    const c = label[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(label[i + 1])) { i += 2; continue; }
    if (c !== '`') { i++; continue; }
    let run = 0;
    while (i + run < n && label[i + run] === '`') run++;
    let j = i + run;
    let closeEnd = -1;
    let nextRunEnd = -1;
    while (j < n) {
      if (label[j] === '\\' && j + 1 < n && isAsciiPunct(label[j + 1])) { j += 2; continue; }
      if (label[j] !== '`') { j++; continue; }
      let r = 0;
      while (j + r < n && label[j + r] === '`') r++;
      if (nextRunEnd < 0) nextRunEnd = j + r;
      if (r === run) { closeEnd = j + r; break; }
      if (r > run) break;
      j += r;
    }
    if (closeEnd >= 0) {
      spans.push({
        end: closeEnd,
        dirty: label.slice(i + run, closeEnd - run).includes('`'),
      });
      i = closeEnd;
      continue;
    }
    if (nextRunEnd >= 0) { i = nextRunEnd; continue; }
    valid = false;
    break;
  }
  return { valid, spans };
}

/**
 * A label cannot form a link in marked when its backtick runs do not
 * pair up (scanLabelBackticks), or when a code span whose content
 * contains a backtick is followed by more label content that is not
 * itself another such span: [a ``c ` d`` tail](x) stays literal, while
 * [a ``c ` d``](x) and [a ``c ` d`` ``b``](x) form the link.
 */
function labelBlocksLink(label) {
  const { valid, spans } = scanLabelBackticks(label);
  if (!valid) return true;
  for (const sp of spans) {
    if (!sp.dirty) continue;
    const rest = label.slice(sp.end).replace(/^[ \t\n]+/, '');
    if (rest !== '' && !/^`{2,}/.test(rest)) return true;
  }
  return false;
}

/**
 * Cut a raw autolink candidate at a trailing parenthesis group that
 * never closes: https://a.io)](https://b.io links only https://a.io)]
 * — the second URL starts a new autolink. The cut works from the last
 * `(` backwards: a `(` with any `)` after it keeps the whole candidate
 * (http://a.com/b((x), http://a.com/b(a(b)c), while a `(` with no `)`
 * after it is cut away and the check repeats on what remains.
 */
function cutUnclosedParen(raw) {
  let u = raw;
  for (;;) {
    const open = u.lastIndexOf('(');
    if (open < 0) return u;
    if (u.indexOf(')', open) >= 0) return u;
    u = u.slice(0, open);
  }
}

function trimAutolink(url) {
  let u = url;
  while (u.length) {
    // A trailing entity-like suffix is removed as a whole before any
    // single-character punctuation trimming.
    const em = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);$/.exec(u);
    if (em) { u = u.slice(0, u.length - em[0].length); continue; }
    const last = u[u.length - 1];
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' ||
        last === ';' || last === '*' || last === '_' || last === '~' ||
        last === "'" || last === '"') {
      u = u.slice(0, -1);
      continue;
    }
    if (last === ')') {
      // Only parentheses are balance-trimmed; ] and } stay in the link.
      // A trailing ) is kept exactly when it is the single ) standing
      // after the last ( of the URL: b(c) and b((x) keep theirs, while
      // b(c)), b((x)) and b((x)y) each shed one, and a URL with no (
      // at all sheds every trailing ).
      const open = u.lastIndexOf('(');
      let closes = 0;
      if (open >= 0) {
        for (let k = open + 1; k < u.length; k++) if (u[k] === ')') closes++;
      }
      if (open < 0 || closes !== 1) { u = u.slice(0, -1); continue; }
    }
    break;
  }
  return u;
}

const EMAIL_LOCAL_RE = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

/**
 * Match an email address at s[pos]. The domain is consumed greedily, then
 * validated: dot-separated labels, ending in an alphanumeric. A trailing
 * dot is dropped; a domain ending in `-` or `_` invalidates the match.
 */
function matchEmailAt(s, pos, nextCh) {
  const n = s.length;
  let i = pos;
  while (i < n && EMAIL_LOCAL_RE.test(s[i])) i++;
  if (i === pos || s[i] !== '@') return null;
  let j = i + 1;
  while (j < n && /[A-Za-z0-9._-]/.test(s[j])) j++;
  // The candidate continues into the next node when that node starts with
  // a domain character (a `_` delimiter or an escaped `-`/`_`): a trailing
  // `-` or `_` then invalidates the address as a whole.
  if (j === n && (nextCh === '_' || nextCh === '-')) return null;
  let domEnd = j;
  while (domEnd > i + 1 && s[domEnd - 1] === '.') domEnd--;
  const domain = s.slice(i + 1, domEnd);
  if (!EMAIL_DOMAIN_RE.test(domain)) return null;
  const lastCh = domain[domain.length - 1];
  if (!((lastCh >= 'a' && lastCh <= 'z') || (lastCh >= 'A' && lastCh <= 'Z') ||
        (lastCh >= '0' && lastCh <= '9'))) return null;
  return { end: domEnd, email: s.slice(pos, domEnd) };
}

/**
 * True when the text in buf ends with a bare autolink whose scan would
 * extend over a following backslash (URL-type autolinks scan to the next
 * whitespace, backslash included; email autolinks stop at the domain).
 */
function bufEndsWithAutolink(buf) {
  if (!buf) return false;
  const ext = buf + '\\';
  for (let p = 0; p < buf.length; p++) {
    const ch = buf[p];
    if (ch !== 'w' && ch !== 'h' && ch !== 'H' && ch !== 'f' && ch !== 'F') continue;
    const m = matchBareAutolink(ext, p, undefined);
    if (m && m.end === ext.length) return true;
  }
  return false;
}

/**
 * Match a URL-type bare autolink (www. or scheme://) at s[pos]. These
 * are recognised during the inline scan itself, before brackets,
 * delimiters or backticks inside the URL can be mistaken for markup:
 * the reference tokenizer commits to the URL at its first character
 * and consumes everything up to whitespace or `<`. Email and mailto:
 * forms are recognised later, at text-render time (matchBareAutolink).
 */
function matchUrlAutolink(s, pos) {
  const n = s.length;
  const prev = pos > 0 ? s[pos - 1] : '';
  const prevAlnum = prev !== '' &&
    ((prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') || (prev >= '0' && prev <= '9'));
  if (s.startsWith('www.', pos)) {
    if (prevAlnum || prev === '<') return null;
    let e = pos;
    while (e < n && !isWsCh(s[e]) && s[e] !== '<') e++;
    const matched = trimAutolink(cutUnclosedParen(s.slice(pos, e)));
    if (matched.length <= 4) return null;
    const domEnd = matched.search(/[/?#]/);
    const domain = domEnd < 0 ? matched.slice(4) : matched.slice(4, domEnd);
    if (domain.indexOf('.') < 0) return null;
    return { end: pos + matched.length, href: 'http://' + matched, text: matched };
  }
  const sm = /^(https?|ftp):\/\//i.exec(s.slice(pos, pos + 8));
  if (sm) {
    if (prevAlnum) return null;
    let e = pos;
    while (e < n && !isWsCh(s[e]) && s[e] !== '<') e++;
    const matched = trimAutolink(cutUnclosedParen(s.slice(pos, e)));
    if (matched.length <= sm[0].length) return null;
    return { end: pos + matched.length, href: matched, text: matched };
  }
  return null;
}

function matchBareAutolink(s, pos, nextCh) {
  const n = s.length;
  const prev = pos > 0 ? s[pos - 1] : '';
  // A www. or scheme:// prefix settles the matter on its own: when it
  // is present but invalid (or blocked by a preceding alphanumeric),
  // no email form is attempted at the same position.
  if (s.startsWith('www.', pos) || /^(https?|ftp):\/\//i.test(s.slice(pos, pos + 8))) {
    return matchUrlAutolink(s, pos);
  }
  if (s.slice(pos, pos + 7).toLowerCase() === 'mailto:') {
    if (prev && EMAIL_PREV_BLOCK_RE.test(prev)) return null;
    const m = matchEmailAt(s, pos + 7, nextCh);
    if (m) {
      const whole = s.slice(pos, m.end);
      return { end: m.end, href: whole, text: whole };
    }
    return null;
  }
  if (s.slice(pos, pos + 5).toLowerCase() === 'xmpp:') {
    if (prev && EMAIL_PREV_BLOCK_RE.test(prev)) return null;
    const m = matchEmailAt(s, pos + 5, nextCh);
    if (m) {
      let end = m.end;
      if (s[end] === '/') {
        let e = end + 1;
        while (e < n && !isWsCh(s[e]) && s[e] !== '<' && s[e] !== '/') e++;
        const res = trimAutolink(s.slice(end + 1, e));
        if (res) end = end + 1 + res.length;
      }
      const whole = s.slice(pos, end);
      return { end, href: whole, text: whole };
    }
    return null;
  }
  const c = s[pos];
  if (c && EMAIL_LOCAL_RE.test(c) && !(prev && EMAIL_PREV_BLOCK_RE.test(prev))) {
    const m = matchEmailAt(s, pos, nextCh);
    if (m) return { end: m.end, href: 'mailto:' + m.email, text: m.email };
  }
  return null;
}

function isAutolinkTrigger(s, j) {
  const c = s[j];
  if (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M') {
    return true;
  }
  const code = s.charCodeAt(j);
  if (isAlphaCode(code) || isDigitCode(code)) {
    if (j === 0) return true;
    return !EMAIL_PREV_BLOCK_RE.test(s[j - 1]);
  }
  return false;
}

function renderText(s, inLink, nextCh) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (!inLink && isAutolinkTrigger(s, i)) {
      const a = matchBareAutolink(s, i, nextCh);
      if (a) {
        out += '<a href="' + escapeHtml(cleanUrl(a.href)) + '">' + escapeHtml(a.text) + '</a>';
        i = a.end;
        continue;
      }
    }
    if (c === '&') {
      NUM_DEC_RE.lastIndex = i;
      let m = NUM_DEC_RE.exec(s);
      if (m) {
        let cp = parseInt(m[1], 10);
        if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        out += escapeHtml(String.fromCodePoint(cp));
        i += m[0].length;
        continue;
      }
      NUM_HEX_RE.lastIndex = i;
      m = NUM_HEX_RE.exec(s);
      if (m) {
        let cp = parseInt(m[1], 16);
        if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        out += escapeHtml(String.fromCodePoint(cp));
        i += m[0].length;
        continue;
      }
      NAMED_ENT_RE.lastIndex = i;
      m = NAMED_ENT_RE.exec(s);
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      if (!inLink && isAutolinkTrigger(s, j)) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Plain-text content of an image's children for its alt attribute:
 * nested links and images contribute their own text, tags vanish. */
function altText(nodes, ctx) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'image' || nd.t === 'link' || nd.t === 'em' ||
        nd.t === 'strong' || nd.t === 'del') {
      out += altText(nd.children, ctx);
    } else if (nd.t === 'html') {
      continue;
    } else if (nd.t === 'text' && nd.esc) {
      out += escapeHtml(nd.s);
    } else {
      out += renderNodes([nd], ctx, true).replace(/<[^>]*>/g, '');
    }
  }
  return out;
}

function renderNodes(nodes, ctx, inLink) {
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    switch (nd.t) {
      case 'text': {
        if (nd.esc) { out += escapeHtml(nd.s); break; }
        // The character that follows this text node in the source, so
        // email matching can tell whether the candidate continues.
        let nextCh = '';
        const nx = nodes[ni + 1];
        if (nx) {
          if (nx.t === 'delim') nextCh = nx.ch;
          else if (nx.t === 'text') nextCh = nx.s[0] ?? '';
        }
        out += renderText(nd.s, inLink || ctx.inRawAnchor, nextCh);
        break;
      }
      case 'code': out += '<code>' + escapeHtml(nd.s) + '</code>'; break;
      case 'html':
        ctx.inRawAnchor = anchorStateAfter(nd.s, ctx.inRawAnchor);
        out += nd.s;
        break;
      case 'br': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'em': out += '<em>' + renderNodes(nd.children, ctx, inLink) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children, ctx, inLink) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children, ctx, inLink) + '</del>'; break;
      case 'link': {
        out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) {
          out += ' title="' + escapeAttr(nd.title) + '"';
        }
        out += '>' + renderNodes(nd.children, ctx, true) + '</a>';
        break;
      }
      case 'image': {
        const alt = altText(nd.children, ctx);
        out += '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' + alt + '"';
        if (nd.title !== null && nd.title !== undefined) {
          out += ' title="' + escapeAttr(nd.title) + '"';
        }
        out += '>';
        break;
      }
      case 'autolink':
        // A BARE autolink recognised at scan time inside a label that
        // turned out to be a real link (or inside a raw <a> element) is
        // not a link for the reference renderer either: it renders as
        // plain text. Angle-bracket autolinks always render as links.
        if (nd.bare && (inLink || ctx.inRawAnchor)) out += escapeHtml(nd.text);
        else out += '<a href="' + escapeHtml(cleanUrl(nd.href)) + '">' + escapeHtml(nd.text) + '</a>';
        break;
      default: break;
    }
  }
  return out;
}

function renderInline(text, ctx) {
  return renderNodes(parseInline(text, ctx), ctx, false);
}

function renderTable(block, ctx) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < block.header.length; c++) {
    const align = block.aligns[c];
    out += '<th' + (align ? ' align="' + align + '"' : '') + '>' +
      renderInline(block.header[c], ctx) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (block.rows.length) {
    out += '<tbody>';
    for (const row of block.rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        const align = block.aligns[c];
        out += '<td' + (align ? ' align="' + align + '"' : '') + '>' +
          renderInline(row[c], ctx) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

const TASK_RE = /^\[(x|X| |)\]/;

function renderListItem(children, loose, ctx) {
  if (children.length === 0) return '<li></li>\n';
  let checkbox = null;
  let firstParaText = null;
  if (children[0].type === 'paragraph') {
    const m = TASK_RE.exec(children[0].text);
    if (m && (children[0].text.length === m[0].length || children[0].text[m[0].length] === ' ')) {
      checkbox = m[1] === 'x' || m[1] === 'X'
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      firstParaText = children[0].text.slice(m[0].length);
    }
  }
  let inner = '';
  for (let idx = 0; idx < children.length; idx++) {
    const b = children[idx];
    if (idx === 0 && checkbox !== null) {
      inner += loose
        ? '<p>' + checkbox + renderInline(firstParaText, ctx) + '</p>\n'
        : checkbox + renderInline(firstParaText, ctx);
      continue;
    }
    inner += renderBlocks([b], ctx, !loose);
  }
  return '<li>' + inner + '</li>\n';
}

function renderList(block, ctx) {
  const tag = block.ordered ? 'ol' : 'ul';
  let out = '<' + tag +
    (block.ordered && block.start !== 1 ? ' start="' + block.start + '"' : '') + '>\n';
  for (const item of block.items) out += renderListItem(item, block.loose, ctx);
  out += '</' + tag + '>\n';
  return out;
}

function renderBlocks(blocks, ctx, tightPara) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        out += tightPara
          ? renderInline(b.text, ctx)
          : '<p>' + renderInline(b.text, ctx) + '</p>\n';
        break;
      case 'heading':
        out += '<h' + b.level + '>' + renderInline(b.text, ctx) + '</h' + b.level + '>\n';
        break;
      case 'code':
        out += '<pre><code' +
          (b.lang ? ' class="language-' + escapeAttr(b.lang) + '"' : '') + '>' +
          escapeHtml(b.text) + '</code></pre>\n';
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'html': out += b.text; break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children, ctx, false) + '</blockquote>\n';
        break;
      case 'list': out += renderList(b, ctx); break;
      case 'table': out += renderTable(b, ctx); break;
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const tailTerminated = lines.length > 1 && lines[lines.length - 1] === '';
  if (tailTerminated) lines.pop();
  const defs = new Map();
  const blocks = lexBlocks(lines, 0, lines.length, defs, tailTerminated);
  const ctx = { defs, inRawAnchor: false };
  return renderBlocks(blocks, ctx, false);
}
