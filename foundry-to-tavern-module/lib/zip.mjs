// Reading a zip in the page: the central directory, then each file only when it's asked for.
// Stored files are slices of the dropped File (nothing copied); deflated ones go through the
// browser's DecompressionStream. No zip64 and no encryption, which export bundles never use.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/**
 * @param {Blob} blob  the zip (a dropped File)
 * @returns {Promise<{ names: string[], has(name): boolean, size(name): number, blob(name, type?): Promise<Blob>, text(name): Promise<string>, json(name): Promise<any> }>}
 */
export async function readZip(blob) {
  if (blob.size < 22) throw new Error('not a zip file');
  const tailStart = Math.max(0, blob.size - 0xffff - 22);
  const tail = await bytesOf(blob, tailStart, blob.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === EOCD) { at = i; break; }
  if (at < 0) throw new Error('not a zip file (no central directory)');
  const count = tv.getUint16(at + 10, true);
  const dirSize = tv.getUint32(at + 12, true);
  const dirOffset = tv.getUint32(at + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('this zip uses zip64, which can’t be read here; export fewer compendiums at a time');
  if (dirOffset + dirSize > blob.size) throw new Error('the zip is cut short');
  const dir = await bytesOf(blob, dirOffset, dirOffset + dirSize);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const utf8 = new TextDecoder();
  const entries = new Map();
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > dir.length || dv.getUint32(p, true) !== CENTRAL) throw new Error('the zip’s directory is damaged');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = utf8.decode(dir.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (/[/\\]$/.test(name)) continue; // a folder
    // Windows PowerShell 5 writes "sub\file.json"; zips mean "/".
    entries.set(name.replace(/\\/g, '/').replace(/^\/+/, ''), { method, compressed, size, offset, encrypted: !!(flags & 1) });
  }

  const open = async (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`${name} is not in the zip`);
    if (e.encrypted) throw new Error(`${name} is encrypted`);
    const head = await bytesOf(blob, e.offset, e.offset + 30);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hv.getUint32(0, true) !== LOCAL) throw new Error(`${name}: the zip is damaged`);
    const start = e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    return { e, data: blob.slice(start, start + e.compressed) };
  };

  const fileBlob = async (name, type = '') => {
    const { e, data } = await open(name);
    if (e.method === 0) return type ? new Blob([data], { type }) : data;
    if (e.method !== 8) throw new Error(`${name} is compressed in a way that can’t be read here (method ${e.method})`);
    if (typeof DecompressionStream !== 'function') throw new Error('this browser can’t unzip files');
    const out = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    return type ? new Blob([out], { type }) : out;
  };

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.size ?? 0,
    blob: fileBlob,
    text: async (name) => (await fileBlob(name)).text(),
    json: async (name) => JSON.parse(await (await fileBlob(name)).text()),
  };
}
