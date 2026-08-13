/* ═══════════════════════════════════════════════════════════════
   uploads — payment screenshots, made safe to keep

   InstaPay has no API, so the evidence a transfer happened is a
   screenshot from the payer's banking app (PLAN §6.2). That is a file
   from a stranger which a moderator will later open, and which §10.6
   says we keep, because it is what settles a dispute. So it gets
   three things done to it before it touches the disk:

     sniffed    the declared content type is ignored entirely; the
                first bytes decide what it is, or it is not stored

     stripped   PNG is decoded and re-encoded through pngjs, which
                keeps the pixels and nothing else. JPEG and WebP
                cannot be re-encoded without a native dependency, so
                their metadata containers are walked instead and
                every EXIF/XMP/comment segment removed. That is the
                part that matters: a phone screenshot can carry GPS,
                and a payment screenshot is already sensitive enough.

     renamed    stored as <payment id>.<ext> under DATA_DIR, which
                http.js refuses to serve — the admin panel reads them
                through an authenticated route, never the static path.

   No multipart parser: the client posts the raw bytes with an image
   content type and sends the reference fields as their own JSON call.
   Two small requests beat hand-rolling RFC 7578.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const cfg = require('./config.js');

const MAX_BYTES = 5 << 20;                      // §6.2

/* ── What is it, really ───────────────────────────────────────── */

const starts = (buf, bytes, at = 0) =>
  buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);

function sniff(buf) {
  if (starts(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
  if (starts(buf, [0xFF, 0xD8, 0xFF])) return 'jpeg';
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && starts(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

/* ── PNG: decode, re-encode, keep the pixels ──────────────────── */

/* The strongest of the three, because it is the only one where the output
   is built from decoded pixel data rather than edited bytes: anything
   hiding in a chunk pngjs does not care about does not survive the trip. */
function cleanPng(buf) {
  const img = PNG.sync.read(buf);
  const out = new PNG({ width: img.width, height: img.height });
  img.data.copy(out.data);
  return { buf: PNG.sync.write(out), ext: 'png', type: 'image/png', w: img.width, h: img.height };
}

/* ── JPEG: drop the metadata segments ─────────────────────────── */

/* A JPEG is SOI then a run of marker segments then entropy-coded data.
   APP1..APP15 is where EXIF and XMP live and COM is a free-text comment;
   none of them are needed to decode the picture. APP0 (JFIF) is kept
   because some decoders still expect it and it holds nothing personal. */
function cleanJpeg(buf) {
  const out = [Buffer.from([0xFF, 0xD8])];
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xFF) break;                 // desynchronised — stop trusting it
    const marker = buf[o + 1];
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { o += 2; continue; }
    const len = buf.readUInt16BE(o + 2);
    if (len < 2 || o + 2 + len > buf.length) break;
    const drop = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
    if (!drop) out.push(buf.subarray(o, o + 2 + len));
    o += 2 + len;
    if (marker === 0xDA) {                      // start of scan: the rest is image data
      out.push(buf.subarray(o));
      o = buf.length;
      break;
    }
  }
  if (o < buf.length) out.push(buf.subarray(o));
  return { buf: Buffer.concat(out), ext: 'jpg', type: 'image/jpeg' };
}

/* ── WebP: drop the metadata chunks ───────────────────────────── */

/* RIFF: "RIFF" u32 size "WEBP" then fourcc/size/payload chunks padded to
   even lengths. EXIF, XMP and ICCP go; VP8X's flag bits advertising them
   have to go with them or a strict decoder will look for chunks that are
   no longer there. */
function cleanWebp(buf) {
  const kept = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const cc = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const end = o + 8 + size + (size % 2);
    if (size < 0 || end > buf.length) break;
    if (cc !== 'EXIF' && cc !== 'XMP ' && cc !== 'ICCP') {
      const chunk = Buffer.from(buf.subarray(o, Math.min(end, buf.length)));
      if (cc === 'VP8X' && chunk.length >= 12) chunk[8] &= ~0b00101100;   // ICC | EXIF | XMP
      kept.push(chunk);
    }
    o = end;
  }
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'ascii');
  return { buf: Buffer.concat([head, body]), ext: 'webp', type: 'image/webp' };
}

/* ── The door ─────────────────────────────────────────────────── */

const CLEANERS = { png: cleanPng, jpeg: cleanJpeg, webp: cleanWebp };

const TOO_BIG = { error: 'too-large', message: 'That image is over 5 MB — a screenshot should be well under.' };
const NOT_IMAGE = {
  error: 'not-an-image',
  message: 'That file is not a PNG, JPEG or WebP image. A screenshot from your banking app is ideal.'
};

/* Returns { file, type, bytes } or { error, message }. Never throws on bad
   input: a corrupt upload is an answer, not an exception. */
function store(buf, name) {
  if (!buf || !buf.length) return NOT_IMAGE;
  if (buf.length > MAX_BYTES) return TOO_BIG;

  const kind = sniff(buf);
  if (!kind) return NOT_IMAGE;

  let clean;
  try { clean = CLEANERS[kind](buf); }
  catch (err) { return NOT_IMAGE; }             // claimed to be a PNG, could not be decoded as one
  if (!clean.buf.length) return NOT_IMAGE;

  const dir = path.join(cfg.DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  /* The name is ours, from the payment id — nothing the caller sent reaches
     the filesystem, so there is no path to traverse and no extension to
     disagree with the bytes. */
  const file = path.join(dir, `${name}.${clean.ext}`);
  fs.writeFileSync(file, clean.buf);
  return { file, type: clean.type, bytes: clean.buf.length, kind };
}

module.exports = { store, sniff, cleanPng, cleanJpeg, cleanWebp, MAX_BYTES, NOT_IMAGE, TOO_BIG };
