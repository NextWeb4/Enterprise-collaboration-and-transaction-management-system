import { Buffer } from 'node:buffer';

export type SpreadsheetValue = string | number;

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Buffer {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function uint32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

/** Store entries without compression to keep the writer small, auditable, and dependency-free. */
function zip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.concat([
      uint32(0x04034b50), uint16(ZIP_VERSION), uint16(UTF8_FLAG), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length), uint16(name.length), uint16(0),
      name, entry.data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      uint32(0x02014b50), uint16(0x0314), uint16(ZIP_VERSION), uint16(UTF8_FLAG), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(central.length), uint32(offset), uint16(0),
  ]);
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeText(value: string): string {
  let firstSignificant = 0;
  let hasLeadingControl = false;
  while (firstSignificant < value.length) {
    const character = value[firstSignificant]!;
    const code = value.charCodeAt(firstSignificant);
    if (character.trim() !== '' && code > 31 && (code < 127 || code > 159)) break;
    if (code <= 31 || (code >= 127 && code <= 159)) hasLeadingControl = true;
    firstSignificant += 1;
  }
  return hasLeadingControl || /^[=+\-@]/u.test(value.slice(firstSignificant)) ? `'${value}` : value;
}

function columnName(index: number): string {
  let result = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function cell(value: SpreadsheetValue, column: number, row: number): string {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === 'number') return `<c r="${reference}" t="n"><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(safeText(value))}</t></is></c>`;
}

function worksheet(rows: readonly (readonly SpreadsheetValue[])[]): string {
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => cell(value, columnIndex, rowIndex + 1)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Generates a minimal, standards-compliant single-sheet XLSX workbook. */
export function singleSheetXlsx(
  sheetName: string,
  rows: readonly (readonly SpreadsheetValue[])[],
): Buffer {
  const safeSheetName = xmlText(sheetName.slice(0, 31) || 'Sheet1');
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 'utf8'),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8'),
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(worksheet(rows), 'utf8') },
  ]);
}
