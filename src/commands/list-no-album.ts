import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db';
import type { PhotoRecord } from '../db';
import { readConfig } from '../config';
import { wrapAction } from '../util';

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function absPath(stored: string, base: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(base, stored);
}

export const listNoAlbumCommand = new Command('list-no-album')
  .description('List files not part of any album, sorted by size')
  .option('-l, --limit <n>', 'Limit the number of listed files', parseInt)
  .option('--only-owned', 'Only show files that you uploaded (excluding shared files that do not consume your storage quota)')
  .option('--csv', 'Output in CSV format')
  .option('--json', 'Output in JSON format')
  .action(
    wrapAction(async (options: { limit?: number; onlyOwned?: boolean; csv?: boolean; json?: boolean }, cmd: Command) => {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);

      if (!options.csv && !options.json) {
        clack.intro('🕊️  Let My Photos Go — List Photos Not in Any Album');
      }

      const config = readConfig();
      const outputDir = config?.outputDir ?? '';

      let db;
      try {
        db = getDb();
      } catch {
        if (!options.csv && !options.json) {
          clack.log.error(`No database found. Run \`${lmpg('enumerate')}\` first.`);
        } else {
          console.error('No database found.');
        }
        process.exit(1);
      }

      // Find the user's own owner token (the most common token in the database)
      let ownToken: string | null = null;
      let totalFilteredShared = 0;
      if (options.onlyOwned) {
        try {
          const row = db.prepare(`
            SELECT owner_token, COUNT(*) as count 
            FROM photos 
            WHERE owner_token IS NOT NULL AND owner_token != ''
            GROUP BY owner_token 
            ORDER BY count DESC 
            LIMIT 1
          `).get() as { owner_token: string; count: number } | undefined;
          
          if (row && row.count > 0) {
            ownToken = row.owner_token;
          }
        } catch {
          // Fallback if table doesn't have owner_token
        }
      }

      // Query all photos that are not part of any album
      let query = `
        SELECT p.* FROM photos p
        LEFT JOIN album_photos ap ON p.media_item_id = ap.media_item_id
        WHERE ap.media_item_id IS NULL
      `;
      const queryParams: any[] = [];

      if (ownToken) {
        // Get count of shared items we are filtering out
        try {
          const countRow = db.prepare(`
            SELECT COUNT(*) as count FROM photos p
            LEFT JOIN album_photos ap ON p.media_item_id = ap.media_item_id
            WHERE ap.media_item_id IS NULL
              AND p.owner_token IS NOT NULL 
              AND p.owner_token != '' 
              AND p.owner_token != ?
          `).get(ownToken) as { count: number } | undefined;
          totalFilteredShared = countRow?.count ?? 0;
        } catch {}

        query += ` AND (p.owner_token = ? OR p.owner_token IS NULL OR p.owner_token = '')`;
        queryParams.push(ownToken);
      }

      let records: PhotoRecord[];
      try {
        records = db.prepare(query).all(...queryParams) as PhotoRecord[];
      } catch (err) {
        if (!options.csv && !options.json) {
          clack.log.error(`Failed to query database: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          console.error('Failed to query database.');
        }
        process.exit(1);
      }

      if (records.length === 0) {
        if (!options.csv && !options.json) {
          clack.log.info('No photos found that are not part of an album.');
          clack.outro('Done.');
        } else if (options.json) {
          console.log(JSON.stringify([]));
        } else if (options.csv) {
          console.log('Filename,CreationTime,Status,SizeBytes,SizeType,QuotaBytes,BackupQuality,GoogleUrl');
        }
        return;
      }

      interface OrphanInfo {
        media_item_id: string;
        filename: string;
        dest_path: string | null;
        google_url: string | null;
        creation_time: string | null;
        status: string;
        sizeBytes: number;
        sizeType: 'Actual' | 'Probed' | 'Estimated';
        quotaBytes: number | null;
        backupQuality: string | null;
      }

      const orphans: OrphanInfo[] = [];
      let pendingCount = 0;
      let failedCount = 0;

      for (const record of records) {
        if (record.status !== 'downloaded') {
          if (record.status === 'failed') {
            failedCount++;
          } else {
            pendingCount++;
          }

          let sizeBytes = 0;
          let sizeType: 'Actual' | 'Probed' | 'Estimated' = 'Estimated';

          if (record.size !== null && record.size !== undefined && record.size > 0) {
            sizeBytes = record.size;
            sizeType = (record.filename && record.filename !== '') ? 'Probed' : 'Estimated';
          } else if (record.width && record.height) {
            sizeBytes = Math.round(record.width * record.height * 0.25);
            sizeType = 'Estimated';
          }

          orphans.push({
            media_item_id: record.media_item_id,
            filename: record.filename || `id:${record.media_item_id}`,
            dest_path: record.dest_path,
            google_url: record.google_url || `https://photos.google.com/photo/${record.media_item_id}`,
            creation_time: record.creation_time,
            status: record.status,
            sizeBytes,
            sizeType,
            quotaBytes: record.quota_bytes,
            backupQuality: record.backup_quality,
          });
          continue;
        }

        let sizeBytes = 0;
        let companionSizeBytes = 0;
        let sizeType: 'Actual' | 'Probed' | 'Estimated' = 'Actual';

        if (record.dest_path) {
          const absFile = absPath(record.dest_path, outputDir);
          try {
            if (fs.existsSync(absFile)) {
              sizeBytes = fs.statSync(absFile).size;
            } else if (record.size !== null && record.size !== undefined && record.size > 0) {
              sizeBytes = record.size;
              sizeType = 'Probed';
            }
          } catch {
            if (record.size !== null && record.size !== undefined && record.size > 0) {
              sizeBytes = record.size;
              sizeType = 'Probed';
            }
          }
        }

        if (record.companion_path) {
          const absCompanion = absPath(record.companion_path, outputDir);
          try {
            if (fs.existsSync(absCompanion)) {
              companionSizeBytes = fs.statSync(absCompanion).size;
            }
          } catch {
            // Companion missing
          }
        }

        orphans.push({
          media_item_id: record.media_item_id,
          filename: record.filename || (record.dest_path ? path.basename(record.dest_path) : ''),
          dest_path: record.dest_path,
          google_url: record.google_url || `https://photos.google.com/photo/${record.media_item_id}`,
          creation_time: record.creation_time,
          status: record.status,
          sizeBytes: sizeBytes + companionSizeBytes,
          sizeType,
          quotaBytes: record.quota_bytes,
          backupQuality: record.backup_quality,
        });
      }

      // Sort: largest effective quota first
      const getEffectiveQuota = (o: OrphanInfo) => {
        return (o.quotaBytes !== null && o.quotaBytes !== undefined) ? o.quotaBytes : o.sizeBytes;
      };
      orphans.sort((a, b) => getEffectiveQuota(b) - getEffectiveQuota(a));

      // Apply limit if specified
      let displayOrphans = orphans;
      if (options.limit !== undefined && !isNaN(options.limit)) {
        displayOrphans = orphans.slice(0, options.limit);
      }

      if (options.json) {
        console.log(JSON.stringify(displayOrphans, null, 2));
        return;
      }

      if (options.csv) {
        console.log('Filename,CreationTime,Status,SizeBytes,SizeType,QuotaBytes,BackupQuality,GoogleUrl');
        for (const o of displayOrphans) {
          const creationStr = o.creation_time || '';
          console.log(`"${o.filename}","${creationStr}","${o.status}",${o.sizeBytes},"${o.sizeType}",${o.quotaBytes || ''},"${o.backupQuality || ''}","${o.google_url}"`);
        }
        return;
      }

      // Default clack text output
      clack.log.info(`Found ${records.length.toLocaleString()} items not in any album (${(records.length - pendingCount - failedCount).toLocaleString()} downloaded).`);

      if (displayOrphans.length > 0) {
        console.log('\nSorted by size (largest first):');
        console.log('--------------------------------------------------------------------------------');
        for (const o of displayOrphans) {
          let sizeLine = `Size:     ${formatBytes(o.sizeBytes)} (${o.sizeType === 'Actual' ? 'Download' : o.sizeType})`;
          if (o.quotaBytes !== null && o.quotaBytes !== undefined) {
            if (o.quotaBytes === 0) {
              sizeLine += ` | Quota: 0 Bytes (Shared)`;
            } else {
              sizeLine += ` | Quota: ${formatBytes(o.quotaBytes)} (${o.backupQuality || 'saver'})`;
            }
          }
          console.log(sizeLine);
          console.log(`Name:     ${o.filename}`);
          console.log(`Status:   ${o.status}`);
          console.log(`Date:     ${o.creation_time || 'Unknown'}`);
          console.log(`URL:      ${o.google_url}`);
          console.log('--------------------------------------------------------------------------------');
        }
      }

      if (options.limit !== undefined && orphans.length > options.limit) {
        clack.log.warn(`Showing only the first ${options.limit} items. Use \`--limit\` to adjust.`);
      }

      if (totalFilteredShared > 0 && options.onlyOwned) {
        clack.log.warn(`Note: Filtered out ${totalFilteredShared.toLocaleString()} shared items that do not consume your quota.`);
      }

      const totalUnestimatedOrphansWithoutResolution = orphans.filter(o => o.sizeBytes === 0).length;
      if (totalUnestimatedOrphansWithoutResolution > 0) {
        clack.log.warn(`Note: ${totalUnestimatedOrphansWithoutResolution} items have unknown resolution and size. Run \`${lmpg('flee')}\` to download and audit them.`);
      }

      clack.outro('Done.');
    })
  );
