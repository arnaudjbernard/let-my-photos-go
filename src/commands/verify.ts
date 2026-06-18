import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDb, resetToPending, setCompanionPath } from '../db.js';
import type { PhotoRecord } from '../db.js';

type IssueReason =
  | 'missing' | 'empty' | 'size-mismatch' | 'corrupt' | 'stale-zip'
  | 'missing-companion' | 'empty-companion' | 'corrupt-companion';
interface Issue { record: PhotoRecord; reason: IssueReason }

const STILL_IMAGE_EXTS = new Set(['.heic', '.jpg', '.jpeg', '.png', '.gif', '.webp']);

const MAGIC_BYTES: Record<string, (b: Buffer) => boolean> = {
  '.jpg':  b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.png':  b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  '.gif':  b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  '.webp': b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  '.heic': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  '.mov':  b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  '.mp4':  b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  '.m4v':  b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
};

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function fileSize(p: string): Promise<number> {
  return fs.stat(p).then(s => s.size);
}

async function checkMagicBytes(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  const checker = MAGIC_BYTES[ext];
  if (!checker) return true;
  const buf = Buffer.alloc(12);
  const fh = await fs.open(filePath, 'r');
  try { await fh.read(buf, 0, 12, 0); } finally { await fh.close(); }
  return checker(buf);
}

export const verifyCommand = new Command('verify')
  .description('Check all downloaded photos exist on disk and are non-empty')
  .option('-f, --fix', 'Reset broken records to pending so `flee --resume` can re-download them')
  .action(async (opts: { fix?: boolean }) => {
    clack.intro('🕊️  Let My Photos Go — Verify');

    let total: number;
    try {
      const db = getDb();
      total = (db.prepare(`SELECT COUNT(*) as count FROM photos WHERE status = 'downloaded'`).get() as { count: number }).count;
    } catch {
      clack.log.info('No database found yet. Run `lmpg flee` to start downloading.');
      clack.outro('');
      return;
    }

    if (total === 0) {
      clack.log.info('No downloaded photos to verify.');
      clack.outro('');
      return;
    }

    const spinner = clack.spinner();
    spinner.start(`Verifying ${total.toLocaleString()} downloaded photos…`);

    const issues: Issue[] = [];
    let checked = 0;
    const pendingBackfills: Array<{ mediaItemId: string; companionPath: string }> = [];

    const db = getDb();
    for (const record of db.prepare(`SELECT * FROM photos WHERE status = 'downloaded'`).iterate() as Iterable<PhotoRecord>) {
      checked++;
      spinner.message(`Verifying ${checked.toLocaleString()} / ${total.toLocaleString()}…`);

      // --- primary file ---
      if (!record.dest_path || !(await fileExists(record.dest_path))) {
        issues.push({ record, reason: 'missing' });
        continue;
      }
      const actualSize = await fileSize(record.dest_path);
      if (actualSize === 0) {
        issues.push({ record, reason: 'empty' });
        continue;
      }
      if (record.expected_size !== null && actualSize !== record.expected_size) {
        issues.push({ record, reason: 'size-mismatch' });
        continue;
      }
      if (!(await checkMagicBytes(record.dest_path))) {
        issues.push({ record, reason: 'corrupt' });
        continue;
      }

      // --- companion file ---
      let companionPath = record.companion_path;

      if (!companionPath && STILL_IMAGE_EXTS.has(path.extname(record.dest_path).toLowerCase())) {
        const candidate = record.dest_path.replace(/\.[^.]+$/, '.mov');
        if (await fileExists(candidate)) {
          companionPath = candidate;
          pendingBackfills.push({ mediaItemId: record.media_item_id, companionPath: candidate });
        }
      }

      if (companionPath) {
        if (!(await fileExists(companionPath))) {
          issues.push({ record, reason: 'missing-companion' });
        } else if ((await fileSize(companionPath)) === 0) {
          issues.push({ record, reason: 'empty-companion' });
        } else if (!(await checkMagicBytes(companionPath))) {
          issues.push({ record, reason: 'corrupt-companion' });
        }
      }
    }

    // Apply backfills after the iterator is closed (can't write while iterating)
    for (const { mediaItemId, companionPath } of pendingBackfills) {
      setCompanionPath(mediaItemId, companionPath);
    }

    // Second pass: records marked downloaded that still point at a .zip
    for (const record of db.prepare(
      `SELECT * FROM photos WHERE status = 'downloaded' AND dest_path LIKE '%.zip'`
    ).iterate() as Iterable<PhotoRecord>) {
      issues.push({ record, reason: 'stale-zip' });
    }

    spinner.stop(`Verified ${total.toLocaleString()} photos.`);

    if (pendingBackfills.length > 0) {
      clack.log.info(`Backfilled companion path for ${pendingBackfills.length.toLocaleString()} Live Photo(s).`);
    }

    if (issues.length === 0) {
      clack.log.success(`All ${total.toLocaleString()} photos OK.`);
      clack.outro('');
      return;
    }

    for (const { record, reason } of issues) {
      const label =
        reason === 'missing'           ? 'MISSING       ' :
        reason === 'empty'             ? 'EMPTY         ' :
        reason === 'size-mismatch'     ? 'SIZE MISMATCH ' :
        reason === 'corrupt'           ? 'CORRUPT       ' :
        reason === 'stale-zip'         ? 'STALE ZIP     ' :
        reason === 'missing-companion' ? 'NO COMPANION  ' :
        reason === 'empty-companion'   ? 'EMPTY MOV     ' :
                                         'CORRUPT MOV   ';
      clack.log.warn(`${label}  ${record.dest_path ?? `(no path) id=${record.media_item_id}`}`);
    }

    clack.log.error(`${issues.length.toLocaleString()} issue(s) found out of ${total.toLocaleString()} checked.`);

    if (opts.fix) {
      for (const { record } of issues) {
        resetToPending(record.media_item_id);
      }
      clack.log.success(`Reset ${issues.length.toLocaleString()} record(s) to pending. Run \`lmpg flee --resume\` to re-download.`);
    } else {
      clack.log.info('Run `lmpg verify --fix` to reset broken records for re-download.');
    }

    clack.outro('');
  });
