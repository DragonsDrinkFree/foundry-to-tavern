// A small zip writer: enough for an export bundle, nothing Foundry-specific (Node runs it in tests).
// Files are stored, or deflated with the browser's CompressionStream when that makes them smaller
// (JSON does; pictures are compressed already, so they're stored and the reader can slice them out).
// No zip64: up to 65,535 files and 4 GB in all, which `ZipWriter` checks as it goes.

const LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new Error('a zip entry is a string, bytes or a Blob');
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Zip entries are named with forward slashes, no leading slash, no "." or ".." parts. */
export function zipName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error(`"${name}" is not a file name`);
  return parts.join('/');
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.names = new Set();
  }

  get size() { return this.offset; }
  get count() { return this.central.length; }
  has(name) { return this.names.has(zipName(name)); }

  /**
   * Add a file. `deflate`: try compressing it (kept only if smaller).
   * @param {string} name
   * @param {string|Uint8Array|ArrayBuffer|Blob} data
   * @param {{ deflate?: boolean, date?: Date }} [opts]
   */
  async add(name, data, { deflate = false, date } = {}) {
    name = zipName(name);
    if (this.names.has(name)) throw new Error(`"${name}" is in the zip already`);
    if (this.central.length >= 0xffff) throw new Error('a zip without zip64 holds at most 65,535 files');
    const bytes = await toBytes(data);
    const crc = crc32(bytes);
    let method = 0;
    let body = bytes;
    if (deflate && bytes.length > 64) {
      const packed = await deflateRaw(bytes);
      if (packed && packed.length < bytes.length) { method = 8; body = packed; }
    }
    const nameBytes = new TextEncoder().encode(name);
    if (this.offset + 30 + nameBytes.length + body.length > LIMIT) throw new Error('the export is larger than 4 GB, which this zip writer can’t do; export fewer compendiums at a time');
    const { time, date: day } = dosDateTime(date);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    // A stored Blob goes in as itself, so its bytes needn't stay in memory twice.
    const isBlob = typeof Blob === 'function' && data instanceof Blob;
    this.parts.push(local.buffer, nameBytes, method === 0 && isBlob ? data : body);
    this.central.push({ nameBytes, method, time, day, crc, compressed: body.length, size: bytes.length, offset: this.offset });
    this.offset += 30 + nameBytes.length + body.length;
    this.names.add(name);
  }

  /** The zip, as a Blob. */
  finish(type = 'application/zip') {
    const dir = [];
    let dirSize = 0;
    for (const e of this.central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true); // made by
      h.setUint16(6, 20, true); // needed
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, e.method, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.day, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.compressed, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      // extra, comment, disk, internal attributes: 0
      h.setUint32(38, 0, true); // external attributes
      h.setUint32(42, e.offset, true);
      dir.push(h.buffer, e.nameBytes);
      dirSize += 46 + e.nameBytes.length;
    }
    if (this.offset + dirSize > LIMIT) throw new Error('the export is larger than 4 GB, which this zip writer can’t do');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...dir, end.buffer], { type });
  }
}
