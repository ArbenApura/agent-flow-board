// THE TESTING EXPORT (AFB-20261127-0438): THE SHEET AS CSV OR AS AN EXCEL FILE, DATA ONLY
// Every cell an agent wrote is untrusted, so a value that starts like a formula (=, +, -, @, a tab or a return) is prefixed with
// an apostrophe in both formats and never runs when the file is opened. Proof pictures stay on the board: a row carries the
// address of its picture, never the file. The Excel file is a plain workbook of one sheet, written as an uncompressed zip so
// no dependency is needed.

// -- TYPES -- //

export type ExportTable = { columns: string[]; rows: string[][] };

// -- CONSTANTS -- //

/** The most rows and the longest cell an export carries. */
export const EXPORT_MAX_ROWS = 5000;
export const EXPORT_MAX_CELL = 2000;
const FORMULA_START = /^[=+\-@\t\r]/;

// -- FUNCTIONS -- //

/** One cell made safe: cut to the cap, control characters out, a formula start defused. */
export function safeCell(value: unknown): string {
	let s = value === null || value === undefined ? '' : String(value);
	// eslint-disable-next-line no-control-regex
	s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
	if (s.length > EXPORT_MAX_CELL) s = `${s.slice(0, EXPORT_MAX_CELL)}…`;
	return FORMULA_START.test(s) ? `'${s}` : s;
}

/** The table as CSV (RFC 4180), with a byte order mark so a spreadsheet reads it as UTF-8. */
export function toCsv(t: ExportTable): string {
	const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	const lines = [t.columns, ...t.rows.slice(0, EXPORT_MAX_ROWS)].map((r) =>
		r.map((v) => q(safeCell(v))).join(',')
	);
	// The byte order mark first, so Excel reads the file as UTF-8
	return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

const xml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The column letters of a zero-based index (0 is A, 26 is AA). */
function colName(i: number): string {
	let n = i + 1;
	let out = '';
	while (n > 0) {
		const r = (n - 1) % 26;
		out = String.fromCharCode(65 + r) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

/** The table as an Excel workbook (.xlsx): one sheet, inline strings, a bold header row frozen at the top. */
export function toXlsx(t: ExportTable, sheetName = 'Test cases'): Uint8Array {
	const rows = [t.columns, ...t.rows.slice(0, EXPORT_MAX_ROWS)];
	const sheetRows = rows
		.map(
			(r, ri) =>
				`<row r="${ri + 1}">${r
					.map(
						(v, ci) =>
							`<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(safeCell(v))}</t></is></c>`
					)
					.join('')}</row>`
		)
		.join('');
	const files: [string, string][] = [
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
		],
		[
			'xl/workbook.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
		],
		[
			'xl/_rels/workbook.xml.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
		],
		[
			'xl/styles.xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'
		],
		[
			'xl/worksheets/sheet1.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows}</sheetData></worksheet>`
		]
	];
	return zipStored(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// -- ZIP -- //

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A zip of the given files, each stored without compression (enough for a small workbook). */
export function zipStored(entries: [string, Uint8Array][]): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const nameBytes = new TextEncoder().encode(name);
		const crc = crc32(data);
		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, 0, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		parts.push(local, data);
		const cen = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(cen.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		cen.set(nameBytes, 46);
		central.push(cen);
		offset += local.length + data.length;
	}
	const cenSize = central.reduce((a, c) => a + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cenSize, true);
	ev.setUint32(16, offset, true);
	const all = [...parts, ...central, end];
	const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
	let at = 0;
	for (const p of all) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
