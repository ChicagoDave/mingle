/**
 * Import/Export — delimited text parsing for card import (Phase 29;
 * legacy `CardImport::ExcelContent`, which read tab-separated
 * clipboard pastes from Excel).
 *
 * Purpose: turns CSV or TSV text into a header row and data rows.
 * The delimiter is detected from the header line (a tab wins,
 * otherwise a comma); fields may be double-quoted, with doubled
 * quotes as escapes and newlines allowed inside quotes (RFC 4180).
 * Blank lines are dropped; short rows are padded to the header's
 * width. Pure.
 *
 * Public interface: `parseDelimited`, `DelimitedTable`.
 *
 * Owner context: Import/Export.
 */

export interface DelimitedTable {
  delimiter: "," | "\t";
  header: string[];
  /** Data rows, each padded to `header.length`; row 2 of the file is index 0. */
  rows: string[][];
}

/**
 * Parses delimited text.
 *
 * @param text - the file or paste, with or without a BOM
 * @returns the table; an empty header when the text has no first line
 */
export function parseDelimited(text: string): DelimitedTable {
  const source = text.replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter: "," | "\t" = firstLine.includes("\t") ? "\t" : ",";
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || record.length > 0) endRecord();

  const nonBlank = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  const header = (nonBlank[0] ?? []).map((cell) => cell.trim());
  const rows = nonBlank.slice(1).map((r) => {
    const padded = r.slice(0, header.length);
    while (padded.length < header.length) padded.push("");
    return padded;
  });
  return { delimiter, header, rows };
}
