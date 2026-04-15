/**
 * Minimal ZIP file writer using Node.js built-ins.
 *
 * Produces ZIP files compatible with the .c3p format (standard ZIP).
 * Uses STORE method (no compression) for simplicity and compatibility
 * with C3's importer. This matches how C3 exports .c3p files.
 *
 * No external dependencies — only uses node:fs and node:buffer.
 */

import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';

interface ZipEntry {
  /** Path inside the zip (forward slashes) */
  path: string;
  /** File data */
  data: Buffer;
}

/**
 * Build a ZIP file from a list of entries and write it to disk.
 * Uses STORE method (no compression) for maximum compatibility.
 */
export async function writeZip(entries: ZipEntry[], outputPath: string): Promise<void> {
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes + path + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // Local file header signature
    localHeader.writeUInt16LE(20, 4);           // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);            // General purpose bit flag
    localHeader.writeUInt16LE(0, 8);            // Compression method: STORE
    localHeader.writeUInt16LE(0, 10);           // Last mod file time
    localHeader.writeUInt16LE(0, 12);           // Last mod file date
    localHeader.writeUInt32LE(crc, 14);         // CRC-32
    localHeader.writeUInt32LE(size, 18);        // Compressed size
    localHeader.writeUInt32LE(size, 22);        // Uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28);           // Extra field length

    // Central directory file header (46 bytes + path)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);     // Central directory signature
    cdHeader.writeUInt16LE(20, 4);              // Version made by (2.0)
    cdHeader.writeUInt16LE(20, 6);              // Version needed to extract
    cdHeader.writeUInt16LE(0, 8);               // General purpose bit flag
    cdHeader.writeUInt16LE(0, 10);              // Compression method: STORE
    cdHeader.writeUInt16LE(0, 12);              // Last mod file time
    cdHeader.writeUInt16LE(0, 14);              // Last mod file date
    cdHeader.writeUInt32LE(crc, 16);            // CRC-32
    cdHeader.writeUInt32LE(size, 20);           // Compressed size
    cdHeader.writeUInt32LE(size, 24);           // Uncompressed size
    cdHeader.writeUInt16LE(pathBuf.length, 28); // File name length
    cdHeader.writeUInt16LE(0, 30);              // Extra field length
    cdHeader.writeUInt16LE(0, 32);              // File comment length
    cdHeader.writeUInt16LE(0, 34);              // Disk number start
    cdHeader.writeUInt16LE(0, 36);              // Internal file attributes
    cdHeader.writeUInt32LE(0, 38);              // External file attributes
    cdHeader.writeUInt32LE(offset, 42);         // Relative offset of local header

    parts.push(localHeader, pathBuf, entry.data);
    centralDirectory.push(cdHeader, pathBuf);
    offset += localHeader.length + pathBuf.length + entry.data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDirectory) {
    cdSize += cd.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // End of central directory signature
  eocd.writeUInt16LE(0, 4);                     // Number of this disk
  eocd.writeUInt16LE(0, 6);                     // Disk where CD starts
  eocd.writeUInt16LE(entries.length, 8);         // Number of CD records on this disk
  eocd.writeUInt16LE(entries.length, 10);        // Total number of CD records
  eocd.writeUInt32LE(cdSize, 12);               // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16);             // Offset of start of CD
  eocd.writeUInt16LE(0, 20);                     // Comment length

  const allParts = [...parts, ...centralDirectory, eocd];
  const zipBuffer = Buffer.concat(allParts);
  await writeFile(outputPath, zipBuffer);
}

/**
 * CRC-32 implementation (IEEE 802.3 polynomial).
 * Used for ZIP local/central file headers.
 */
function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
