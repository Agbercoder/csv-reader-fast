// csv-reader-fast: a faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly csv-reader 1.0.0's answer {columns, rows, errors} for one case's
// input {text, header}, read once, left to right, with commas and double quotes. The house
// baseline reads one character at a time and builds every field a character at a time; this
// module instead jumps between delimiters with indexOf and slices whole fields at once, so its
// CPU time on a set of cases is far below the baseline's. The reading policy is csv-reader's
// own, reproduced field for field:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote and each CRLF or lone CR inside it read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one case to the next, so two
// runs on the same cases answer byte for byte the same.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Scratch shared by the field readers: the field just read and how it ended.
  let fv = '';
  let fe = END;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, onto `init` ('' normally, '"' when a quote that
  // never closed is re-read as unquoted). Jumps to the next comma or line break with indexOf;
  // a stray CR before the field ends falls back to the slow loop below. Sets fv/fe.
  function readUnquoted(init) {
    const c = text.indexOf(',', pos);
    const n = text.indexOf('\n', pos);
    let end;
    let isComma;
    let isNL;
    if (c !== -1 && (n === -1 || c < n)) {
      end = c;
      isComma = true;
      isNL = false;
    } else if (n !== -1) {
      end = n;
      isComma = false;
      isNL = true;
    } else {
      end = len;
      isComma = false;
      isNL = false;
    }
    let value = text.slice(pos, end);
    if (isNL && value.length > 0 && value.charCodeAt(value.length - 1) === 13) {
      value = value.slice(0, -1); // the CR of a CRLF line break
    }
    if (value.indexOf('\r') !== -1) {
      readUnquotedSlow(init);
      return;
    }
    fv = init + value;
    if (isComma) {
      pos = end + 1;
      fe = COMMA;
    } else if (isNL) {
      pos = end + 1;
      line += 1;
      fe = LINE;
    } else {
      pos = len;
      fe = END;
    }
  }

  // The same unquoted read, one character at a time: only a field holding a stray CR comes
  // here, so the cost is paid where a CR actually sits. Sets fv/fe.
  function readUnquotedSlow(init) {
    let value = init;
    let seg = pos;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 44) {
        value += text.slice(seg, pos);
        pos += 1;
        fv = value;
        fe = COMMA;
        return;
      }
      if (ch === 10) {
        value += text.slice(seg, pos);
        pos += 1;
        line += 1;
        fv = value;
        fe = LINE;
        return;
      }
      if (ch === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          value += text.slice(seg, pos);
          pos += 2;
          line += 1;
          fv = value;
          fe = LINE;
          return;
        }
        err('stray_cr');
        value += text.slice(seg, pos);
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(seg, pos);
    fv = value;
    fe = END;
  }

  // Reads a quoted field whose opening quote is at pos. Finds the closing quote with indexOf,
  // skipping "" pairs; a quote that never closes is read again as unquoted. Sets fv/fe.
  function readQuoted() {
    const open = pos;
    let q = text.indexOf('"', pos + 1);
    let doubled = false;
    while (q !== -1 && q + 1 < len && text.charCodeAt(q + 1) === 34) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again
      // as unquoted. The line is still the opening quote's line: nothing was counted yet.
      err('unterminated_quote');
      pos = open + 1;
      readUnquoted('"');
      return;
    }
    let value;
    const nl = text.indexOf('\n', open + 1);
    const hasNL = nl !== -1 && nl < q;
    const cr = text.indexOf('\r', open + 1);
    const hasCR = cr !== -1 && cr < q;
    if (!hasNL && !hasCR) {
      value = doubled ? text.slice(open + 1, q).replaceAll('""', '"') : text.slice(open + 1, q);
    } else {
      // A quoted field spanning lines: each CRLF and each lone CR inside it is one LF, and
      // each is one line. The content is small next to a whole case, so a direct pass is fine.
      const content = text.slice(open + 1, q);
      let breaks = 0;
      for (let i = 0; i < content.length; i++) {
        const ch = content.charCodeAt(i);
        if (ch === 10 || ch === 13) breaks += 1;
      }
      line += breaks;
      value = content.replace(/\r\n?/g, '\n');
      if (doubled) value = value.replaceAll('""', '"');
    }
    pos = q + 1;
    if (pos >= len) {
      fv = value;
      fe = END;
      return;
    }
    const ch = text.charCodeAt(pos);
    if (ch === 44) {
      pos += 1;
      fv = value;
      fe = COMMA;
      return;
    }
    if (ch === 10) {
      pos += 1;
      line += 1;
      fv = value;
      fe = LINE;
      return;
    }
    if (ch === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fv = value;
      fe = LINE;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line
    // break; junk only counts when it kept a character.
    readUnquoted(value);
    if (fv.length > value.length) err('quote_junk');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's first line holds no quote, so the record is that one line and
    // its fields are a plain split. A stray CR on the line falls through to the field loop.
    const n = text.indexOf('\n', pos);
    const lineEnd = n === -1 ? len : n;
    let segEnd = lineEnd;
    if (n !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) segEnd = lineEnd - 1;
    const seg = text.slice(pos, segEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = n === -1 ? len : n + 1;
      if (n !== -1) line += 1;
      // A line that held only stray CRs is left with no characters: no record.
      if (fields.length === 1 && fields[0] === '') continue;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Field by field: quoted fields, stray CRs and quote junk live here.
    const fields = [];
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        readQuoted();
        lastQuoted = true;
      } else {
        readUnquoted('');
        lastQuoted = false;
      }
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
