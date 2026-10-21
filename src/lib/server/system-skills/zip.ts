// A STORED (UNCOMPRESSED) ZIP WRITER, SO THE SKILLS BUNDLE NEEDS NO NEW DEPENDENCY (AFB-20261021-0401)
// The bundle is a few hundred kilobytes of text and is built once per process, so compression buys nothing.

// -- TYPES -- //

export type ZipEntry = { path: string; data: Uint8Array };

// -- CONSTANTS -- //

/** 1980-01-01 00:00, the earliest time a zip can hold, so the same bytes come out on every run. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

// -- FUNCTIONS -- //

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** The zip file of these entries, in the order given. */
export function zipStored(entries: ZipEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.path);
		const crc = crc32(entry.data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		// Bit 11: the file name is UTF-8
		local.setUint16(6, 0x0800, true);
		local.setUint16(8, 0, true);
		local.setUint16(10, DOS_TIME, true);
		local.setUint16(12, DOS_DATE, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, entry.data.length, true);
		local.setUint32(22, entry.data.length, true);
		local.setUint16(26, name.length, true);
		local.setUint16(28, 0, true);
		chunks.push(new Uint8Array(local.buffer), name, entry.data);

		const head = new DataView(new ArrayBuffer(46));
		head.setUint32(0, 0x02014b50, true);
		head.setUint16(4, 20, true);
		head.setUint16(6, 20, true);
		head.setUint16(8, 0x0800, true);
		head.setUint16(10, 0, true);
		head.setUint16(12, DOS_TIME, true);
		head.setUint16(14, DOS_DATE, true);
		head.setUint32(16, crc, true);
		head.setUint32(20, entry.data.length, true);
		head.setUint32(24, entry.data.length, true);
		head.setUint16(28, name.length, true);
		head.setUint32(42, offset, true);
		central.push(new Uint8Array(head.buffer), name);
		offset += 30 + name.length + entry.data.length;
	}
	const centralSize = central.reduce((n, c) => n + c.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	const all = [...chunks, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of all) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}
