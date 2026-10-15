// Durable namespace formats of the OPFS backend.
//
// The namespace is persisted as a sequence of records over directory ids
// and data-file ids. A snapshot is a header plus the records that rebuild
// the whole tree from an empty root (MKDIR, FILE and SYMLINK, in tree
// order), so loading a snapshot and replaying later changes share one
// decoder and one apply step.
//
// All integers inside a record are unsigned LEB128 varints and names are
// length-prefixed UTF-8. Fixed-size headers are little-endian.
//
// Every namespace file starts with a 4-byte magic naming its format, and
// its checksum covers that magic along with the rest of its header (see
// `decodeSnapshot`). Any change to a format must keep both: a new magic,
// and a checksum that covers it. That is what lets an older version tell
// a later format, which it must refuse, from a torn write, which it may
// ignore.

/** Directory id of the namespace root. */
export const ROOT_DIR_ID = 0;

export const Op = {
  Mkdir: 1,
  File: 2,
  Symlink: 3,
  Remove: 4,
  Rename: 5,
} as const;

export type NsRecord =
  | { op: typeof Op.Mkdir; parent: number; name: string; dir: number }
  | { op: typeof Op.File; parent: number; name: string; file: number }
  | { op: typeof Op.Symlink; parent: number; name: string; target: string }
  | { op: typeof Op.Remove; parent: number; name: string }
  | {
      op: typeof Op.Rename;
      fromParent: number;
      fromName: string;
      toParent: number;
      toName: string;
    };

/** Thrown by `ByteReader` and the decoders on malformed input. */
export class FormatError extends Error {}

/**
 * Thrown for a slot (or log) that holds intact bytes this version cannot
 * read, such as a format a later uwasi wrote. Unlike a torn write, it must
 * not be ignored, since the store it belongs to would then open as empty.
 */
export class UnknownFormatError extends Error {}

export function fnv1a(bytes: Uint8Array, hash = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** A growable byte buffer for encoding. */
export class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(capacity = 256) {
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  /** Overwrite a u32 written earlier, e.g. a length or checksum slot. */
  patchU32(at: number, value: number): void {
    this.view.setUint32(at, value, true);
  }

  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`uwasi: cannot encode ${value} as a varint`);
    }
    this.reserve(8);
    while (value >= 0x80) {
      this.buffer[this.length++] = value % 0x80 | 0x80;
      value = Math.floor(value / 0x80);
    }
    this.buffer[this.length++] = value;
  }

  string(value: string): void {
    const bytes = utf8Encoder.encode(value);
    this.varint(bytes.byteLength);
    this.reserve(bytes.byteLength);
    this.buffer.set(bytes, this.length);
    this.length += bytes.byteLength;
  }

  /** A view of the bytes written so far; invalidated by further writes. */
  bytes(start = 0): Uint8Array {
    return this.buffer.subarray(start, this.length);
  }

  reset(): void {
    this.length = 0;
  }
}

/** A bounds-checked cursor over encoded bytes. */
export class ByteReader {
  offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.byteLength,
  ) {
    this.offset = start;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  u8(): number {
    if (this.offset >= this.end) throw new FormatError("truncated record");
    return this.bytes[this.offset++];
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > 2 ** 49) throw new FormatError("varint too long");
    }
    if (!Number.isSafeInteger(result)) throw new FormatError("varint range");
    return result;
  }

  string(): string {
    const length = this.varint();
    if (this.offset + length > this.end) {
      throw new FormatError("truncated string");
    }
    const value = utf8Decoder.decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return value;
  }
}

export function encodeRecord(out: ByteWriter, record: NsRecord): void {
  out.u8(record.op);
  switch (record.op) {
    case Op.Mkdir:
      out.varint(record.parent);
      out.string(record.name);
      out.varint(record.dir);
      break;
    case Op.File:
      out.varint(record.parent);
      out.string(record.name);
      out.varint(record.file);
      break;
    case Op.Symlink:
      out.varint(record.parent);
      out.string(record.name);
      out.string(record.target);
      break;
    case Op.Remove:
      out.varint(record.parent);
      out.string(record.name);
      break;
    case Op.Rename:
      out.varint(record.fromParent);
      out.string(record.fromName);
      out.varint(record.toParent);
      out.string(record.toName);
      break;
  }
}

export function decodeRecord(input: ByteReader): NsRecord {
  const op = input.u8();
  switch (op) {
    case Op.Mkdir:
      return {
        op,
        parent: input.varint(),
        name: input.string(),
        dir: input.varint(),
      };
    case Op.File:
      return {
        op,
        parent: input.varint(),
        name: input.string(),
        file: input.varint(),
      };
    case Op.Symlink:
      return {
        op,
        parent: input.varint(),
        name: input.string(),
        target: input.string(),
      };
    case Op.Remove:
      return { op, parent: input.varint(), name: input.string() };
    case Op.Rename:
      return {
        op,
        fromParent: input.varint(),
        fromName: input.string(),
        toParent: input.varint(),
        toName: input.string(),
      };
    default:
      throw new FormatError(`unknown record op ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot slots
// ---------------------------------------------------------------------------

/**
 * Slot layout:
 *
 *   magic[4] | u32 body length | u32 checksum | body
 *
 * A "UWS2" body is `varint gen` followed by records to the end of the
 * body. Id counters are not stored: every live id appears in the records,
 * and the data-file scan covers ids handed out to spares. Its checksum is
 * FNV-1a over the first 8 bytes (magic and length), continued over the
 * body.
 */
const SLOT_HEADER = 12;
const SNAPSHOT_MAGIC = [0x55, 0x57, 0x53, 0x32]; // "UWS2"

/** Begin a snapshot: reserve the slot header and write the body header. */
export function beginSnapshot(out: ByteWriter, gen: number): void {
  out.reset();
  for (const byte of SNAPSHOT_MAGIC) out.u8(byte);
  out.u32(0);
  out.u32(0);
  out.varint(gen);
}

/** Seal a snapshot begun with `beginSnapshot`; returns the slot bytes. */
export function finishSnapshot(out: ByteWriter): Uint8Array {
  const body = out.bytes(SLOT_HEADER);
  out.patchU32(4, body.byteLength);
  out.patchU32(8, fnv1a(body, fnv1a(out.bytes().subarray(0, 8))));
  return out.bytes();
}

export type Snapshot = { gen: number; records: NsRecord[] };

/**
 * Parse a slot's bytes; `null` for an empty or torn slot. Throws
 * `UnknownFormatError` for a slot holding intact bytes this version
 * cannot read, which may hold the newest namespace: one whose checksum
 * verifies, over the header too, but whose magic is unknown or whose
 * "UWS2" body does not decode. No torn write passes for one: a write torn
 * in the header leaves a header the checksum does not match.
 *
 * A magic of four nonzero bytes other than "UWS2" is refused even if the
 * checksum does not verify. This version writes "UWS2" only over "UWS2"
 * or zeros, since it refuses a store holding anything else before
 * writing to it, so a tear leaves "UWS2" or a zero byte: storage that
 * extended a file but lost the write shows zeros. A magic of four
 * nonzero other bytes is therefore not a tear, but another format,
 * most likely a later one that did not keep this checksum. Anything else with a zero byte in its magic is torn unless it
 * verifies.
 */
export function decodeSnapshot(buffer: Uint8Array): Snapshot | null {
  if (buffer.byteLength >= 4) refuseForeignMagic(buffer, [SNAPSHOT_MAGIC]);
  if (buffer.byteLength < SLOT_HEADER) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const length = view.getUint32(4, true);
  if (SLOT_HEADER + length > buffer.byteLength) return null;
  const body = buffer.subarray(SLOT_HEADER, SLOT_HEADER + length);
  const check = view.getUint32(8, true);
  if (fnv1a(body, fnv1a(buffer.subarray(0, 8))) !== check) return null;
  if (!hasMagic(buffer, SNAPSHOT_MAGIC)) {
    throw new UnknownFormatError(`magic ${JSON.stringify(magicOf(buffer))}`);
  }
  try {
    const input = new ByteReader(body);
    const gen = input.varint();
    const records: NsRecord[] = [];
    while (!input.done) records.push(decodeRecord(input));
    return { gen, records };
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    throw new UnknownFormatError(`"UWS2" body: ${error.message}`);
  }
}

/**
 * Throw `UnknownFormatError` if `buffer` starts with a magic of four
 * nonzero bytes none of `known`; see `decodeSnapshot` for why no torn
 * write leaves one.
 */
function refuseForeignMagic(buffer: Uint8Array, known: number[][]): void {
  if (buffer.subarray(0, 4).includes(0)) return;
  if (known.some((magic) => hasMagic(buffer, magic))) return;
  throw new UnknownFormatError(`magic ${JSON.stringify(magicOf(buffer))}`);
}

function magicOf(buffer: Uint8Array): string {
  return String.fromCharCode(...buffer.subarray(0, 4));
}

function hasMagic(buffer: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => buffer[i] === byte);
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

/**
 * Log layout:
 *
 *   "UWL2" | u32 check | u32 gen low | u32 gen high
 *   then frames: u32 body length | u32 check | body (one record)
 *
 * The header's check is FNV-1a over the magic (bytes 0..4), continued
 * over the generation (bytes 8..16), so as for a slot no torn header
 * passes for an intact one. This version writes "UWL2" only over "UWL2"
 * or zeros, so an unknown magic of four nonzero bytes is refused whatever
 * its check (see `decodeSnapshot`).
 *
 * The header names the snapshot generation the log builds on; a log whose
 * generation is not the loaded snapshot's is ignored, because compaction
 * writes the next snapshot before it resets the log. A frame's check is
 * FNV-1a of its body seeded with the generation and the frame's offset, so
 * bytes left over from an earlier generation, or from a frame that sat at
 * another offset, never pass as a record. A complete frame that a failed
 * append left at the end of the log does verify: the failed change may
 * take effect after all. Replay stops at the first frame that does not
 * verify: an append is acknowledged only after its flush, so anything past
 * that point was never reported durable. A frame that verifies but does
 * not decode to exactly one record was written whole, so it is not a tear
 * but a format this version cannot read, and the log is refused: ending
 * replay there would drop every change after it for good, as the open
 * compacts.
 */
export const LOG_HEADER = 16;
const LOG_MAGIC = [0x55, 0x57, 0x4c, 0x32]; // "UWL2"
const FRAME_HEADER = 8;

function splitGen(gen: number): [number, number] {
  return [gen >>> 0, Math.floor(gen / 0x100000000)];
}

export function encodeLogHeader(gen: number): Uint8Array {
  const header = new Uint8Array(LOG_HEADER);
  const view = new DataView(header.buffer);
  header.set(LOG_MAGIC, 0);
  const [low, high] = splitGen(gen);
  view.setUint32(8, low, true);
  view.setUint32(12, high, true);
  view.setUint32(4, logHeaderCheck(header), true);
  return header;
}

function logHeaderCheck(header: Uint8Array): number {
  return fnv1a(header.subarray(8, LOG_HEADER), fnv1a(header.subarray(0, 4)));
}

function frameSeed(gen: number, offset: number): number {
  const seed = new Uint8Array(8);
  const view = new DataView(seed.buffer);
  view.setUint32(0, splitGen(gen)[0], true);
  view.setUint32(4, offset >>> 0, true);
  return fnv1a(seed);
}

/** Encode `record` as the frame to append at `offset` of a `gen` log. */
export function encodeFrame(
  out: ByteWriter,
  record: NsRecord,
  gen: number,
  offset: number,
): Uint8Array {
  out.reset();
  out.u32(0);
  out.u32(0);
  encodeRecord(out, record);
  const body = out.bytes(FRAME_HEADER);
  out.patchU32(0, body.byteLength);
  out.patchU32(4, fnv1a(body, frameSeed(gen, offset)));
  return out.bytes();
}

/**
 * The records of a log built on snapshot `gen`, up to the first frame that
 * does not verify; `null` when the log is empty, torn in its header, or
 * built on another generation (or `gen` is `null`: no snapshot loaded).
 * Throws `UnknownFormatError` for a header under a magic this version does
 * not read, and for a frame that verifies but does not decode.
 */
export function decodeLog(
  buffer: Uint8Array,
  gen: number | null,
): NsRecord[] | null {
  if (buffer.byteLength >= 4) refuseForeignMagic(buffer, [LOG_MAGIC]);
  if (buffer.byteLength < LOG_HEADER) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  if (logHeaderCheck(buffer) !== view.getUint32(4, true)) return null;
  if (!hasMagic(buffer, LOG_MAGIC)) {
    throw new UnknownFormatError(`magic ${JSON.stringify(magicOf(buffer))}`);
  }
  if (gen === null) return null;
  const [low, high] = splitGen(gen);
  if (view.getUint32(8, true) !== low || view.getUint32(12, true) !== high) {
    return null;
  }
  const records: NsRecord[] = [];
  let offset = LOG_HEADER;
  while (offset + FRAME_HEADER <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const start = offset + FRAME_HEADER;
    if (length === 0 || start + length > buffer.byteLength) break;
    const body = buffer.subarray(start, start + length);
    if (
      fnv1a(body, frameSeed(gen, offset)) !== view.getUint32(offset + 4, true)
    ) {
      break;
    }
    try {
      const input = new ByteReader(body);
      const record = decodeRecord(input);
      if (!input.done) throw new FormatError("bytes after the record");
      records.push(record);
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      throw new UnknownFormatError(
        `frame at offset ${offset}: ${error.message}`,
      );
    }
    offset = start + length;
  }
  return records;
}
