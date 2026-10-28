/** Parse a bounded CSV or JSON record import without converting IDs or dates. */
export function parseRecordImport(
  text: string,
  filename: string,
): Record<string, unknown>[] {
  if (new TextEncoder().encode(text).length > 750000)
    throw new Error("Import up to 750 KB at a time.");
  if (/\.json$/i.test(filename)) {
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 500 ||
      value.some((r) => !r || typeof r !== "object" || Array.isArray(r))
    )
      throw new Error("Use a JSON array of 1–500 record objects.");
    return value as Record<string, unknown>[];
  }
  if (!/\.csv$/i.test(filename)) throw new Error("Choose a CSV or JSON file.");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    afterQuote = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += char;
    } else if (char === '"') {
      if (field || afterQuote) throw new Error("Invalid CSV quoting.");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      afterQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      field = "";
      afterQuote = false;
    } else {
      if (afterQuote)
        throw new Error("Unexpected text after a quoted CSV field.");
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV field.");
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const headers = rows.shift()?.map((h) => h.trim());
  if (
    !headers?.length ||
    headers.some((h) => !h) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("CSV needs unique, non-empty column names.");
  if (!rows.length || rows.length > 500)
    throw new Error("Import 1–500 records at a time.");
  return rows.map((values, i) => {
    if (values.length !== headers.length)
      throw new Error(
        `CSV row ${i + 2} has ${values.length} fields; expected ${headers.length}.`,
      );
    return Object.fromEntries(headers.map((h, j) => [h, values[j]]));
  });
}
