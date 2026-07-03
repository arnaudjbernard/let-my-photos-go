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

interface AlbumPhotoRecord extends PhotoRecord {
  albums: string;
}

export const listAlbumCommand = new Command('list-album')
  .description('List files that are part of at least one album, sorted by size')
  .option('-l, --limit <n>', 'Limit the number of listed files', parseInt)
  .option('--only-owned', 'Only show files that you uploaded (excluding shared files that do not consume your storage quota)')
  .option('--csv', 'Output in CSV format')
  .option('--json', 'Output in JSON format')
  .action(
    wrapAction(async (options: { limit?: number; onlyOwned?: boolean; csv?: boolean; json?: boolean }, cmd: Command) => {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);

      if (!options.csv && !options.json) {
        clack.intro('🕊️  Let My Photos Go — List Photos In Albums');
      }

      const config = readConfig();
      const outputDir = config?.outputDir ?? '';

      let db;
      try {
        db = getDb();
      } catch {
        if (!options.csv && !options.json) {
          clack.log.error(`No database found. Run \`${lmpg('enumerate')}\` and \`enumerate-albums\` first.`);
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

      // Query all photos that are part of at least one album
      let query = `
        SELECT p.*, GROUP_CONCAT(a.title, ', ') as albums
        FROM photos p
        JOIN album_photos ap ON p.media_item_id = ap.media_item_id
        JOIN albums a ON ap.album_id = a.album_id
      `;
      const queryParams: any[] = [];

      if (ownToken) {
        // Get count of shared items we are filtering out
        try {
          const countRow = db.prepare(`
            SELECT COUNT(DISTINCT p.media_item_id) as count 
            FROM photos p
            JOIN album_photos ap ON p.media_item_id = ap.media_item_id
            WHERE p.owner_token IS NOT NULL 
              AND p.owner_token != '' 
              AND p.owner_token != ?
          `).get(ownToken) as { count: number } | undefined;
          totalFilteredShared = countRow?.count ?? 0;
        } catch {}

        query += ` WHERE (p.owner_token = ? OR p.owner_token IS NULL OR p.owner_token = '')`;
        queryParams.push(ownToken);
      }

      query += ` GROUP BY p.media_item_id`;

      let records: AlbumPhotoRecord[];
      try {
        records = db.prepare(query).all(...queryParams) as AlbumPhotoRecord[];
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
          clack.log.info('No photos found that are part of an album.');
          clack.outro('Done.');
        } else if (options.json) {
          console.log(JSON.stringify([]));
        } else if (options.csv) {
          console.log('Filename,Albums,CreationTime,Status,SizeBytes,IsEstimated,GoogleUrl');
        }
        return;
      }

      interface AlbumPhotoInfo {
        media_item_id: string;
        filename: string;
        albums: string;
        dest_path: string | null;
        google_url: string | null;
        creation_time: string | null;
        status: string;
        sizeBytes: number;
        isEstimated: boolean;
      }

      const listItems: AlbumPhotoInfo[] = [];
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
          let isEstimated = true;

          if (record.size !== null && record.size !== undefined && record.size > 0) {
            sizeBytes = record.size;
            isEstimated = false;
          } else if (record.width && record.height) {
            sizeBytes = Math.round(record.width * record.height * 0.25);
            isEstimated = true;
          }

          listItems.push({
            media_item_id: record.media_item_id,
            filename: record.filename || `id:${record.media_item_id}`,
            albums: record.albums,
            dest_path: record.dest_path,
            google_url: record.google_url || `https://photos.google.com/photo/${record.media_item_id}`,
            creation_time: record.creation_time,
            status: record.status,
            sizeBytes,
            isEstimated,
          });
          continue;
        }

        let sizeBytes = 0;
        let companionSizeBytes = 0;
        let isEstimated = false;

        if (record.dest_path) {
          const absFile = absPath(record.dest_path, outputDir);
          try {
            if (fs.existsSync(absFile)) {
              sizeBytes = fs.statSync(absFile).size;
            } else if (record.size !== null && record.size !== undefined && record.size > 0) {
              sizeBytes = record.size;
              isEstimated = true;
            }
          } catch {
            if (record.size !== null && record.size !== undefined && record.size > 0) {
              sizeBytes = record.size;
              isEstimated = true;
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

        listItems.push({
          media_item_id: record.media_item_id,
          filename: record.filename || (record.dest_path ? path.basename(record.dest_path) : ''),
          albums: record.albums,
          dest_path: record.dest_path,
          google_url: record.google_url || `https://photos.google.com/photo/${record.media_item_id}`,
          creation_time: record.creation_time,
          status: record.status,
          sizeBytes: sizeBytes + companionSizeBytes,
          isEstimated,
        });
      }

      // Sort: largest size first
      listItems.sort((a, b) => b.sizeBytes - a.sizeBytes);

      // Apply limit if specified
      let displayItems = listItems;
      if (options.limit !== undefined && !isNaN(options.limit)) {
        displayItems = listItems.slice(0, options.limit);
      }

      if (options.json) {
        console.log(JSON.stringify(displayItems, null, 2));
        return;
      }

      if (options.csv) {
        console.log('Filename,Albums,CreationTime,Status,SizeBytes,IsEstimated,GoogleUrl');
        for (const o of displayItems) {
          const creationStr = o.creation_time || '';
          console.log(`"${o.filename}","${o.albums}","${creationStr}","${o.status}",${o.sizeBytes},${o.isEstimated},"${o.google_url}"`);
        }
        return;
      }

      clack.log.info(`Found ${records.length.toLocaleString()} items in albums (${(records.length - pendingCount - failedCount).toLocaleString()} downloaded).`);

      if (displayItems.length > 0) {
        console.log('\nSorted by size (largest first):');
        console.log('--------------------------------------------------------------------------------');
        for (const o of displayItems) {
          let sizeStr = '';
          if (o.isEstimated) {
            sizeStr = o.sizeBytes > 0 ? `~ ${formatBytes(o.sizeBytes)} (Estimated)` : 'Unknown';
          } else {
            sizeStr = `${formatBytes(o.sizeBytes)} (Actual)`;
          }

          console.log(`Size:     ${sizeStr}`);
          console.log(`Name:     ${o.filename}`);
          console.log(`Albums:   ${o.albums}`);
          console.log(`Status:   ${o.status}`);
          console.log(`Date:     ${o.creation_time || 'Unknown'}`);
          console.log(`URL:      ${o.google_url}`);
          console.log('--------------------------------------------------------------------------------');
        }
      }

      if (options.limit !== undefined && listItems.length > options.limit) {
        clack.log.warn(`Showing only the first ${options.limit} items. Use \`--limit\` to adjust.`);
      }

      if (totalFilteredShared > 0 && options.onlyOwned) {
        clack.log.warn(`Note: Filtered out ${totalFilteredShared.toLocaleString()} shared items that do not consume your quota.`);
      }

      clack.outro('Done.');
    })
  );
