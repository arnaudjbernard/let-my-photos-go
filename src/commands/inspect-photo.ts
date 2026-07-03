import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { getDb } from '../db';
import type { PhotoRecord } from '../db';
import { wrapAction } from '../util';

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function extractId(input: string): string {
  if (input.includes('/photo/')) {
    const parts = input.split('/photo/');
    return parts[parts.length - 1].split('/')[0].split('?')[0];
  }
  return input.trim();
}

export const inspectPhotoCommand = new Command('inspect-photo')
  .description('Inspect the metadata and album membership of a photo URL or ID')
  .argument('<url-or-id>', 'The Google Photos URL or photo ID to inspect')
  .action(async (urlOrId: string, options: {}, cmd: Command) => {
    try {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);

      clack.intro('🕊️  Let My Photos Go — Inspect Photo');

      const id = extractId(urlOrId);
      clack.log.info(`Target Media Item ID: ${id}`);

      let db;
      try {
        db = getDb();
      } catch {
        clack.log.error(`No database found. Run \`${lmpg('enumerate')}\` and \`enumerate-albums\` first.`);
        process.exit(1);
      }

      // 1. Fetch photo record
      let record: PhotoRecord | undefined;
      try {
        record = db.prepare(`SELECT * FROM photos WHERE media_item_id = ?`).get(id) as PhotoRecord | undefined;
      } catch (err) {
        clack.log.error(`Database query failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // 2. Fetch album memberships
      let albums: { title: string }[] = [];
      try {
        albums = db.prepare(`
          SELECT a.title 
          FROM album_photos ap
          JOIN albums a ON ap.album_id = a.album_id
          WHERE ap.media_item_id = ?
        `).all(id) as { title: string }[];
      } catch (err) {
        clack.log.warn(`Could not query albums: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!record) {
        clack.log.warn(`No record found for this photo ID in your database. 
You may need to run \`${lmpg('enumerate')}\` if you haven't scanned this photo's date range yet.`);
        
        if (albums.length > 0) {
          console.log('\nAlbum membership found in database:');
          console.log('--------------------------------------------------------------------------------');
          console.log(`Albums:   ${albums.map(a => a.title).join(', ')}`);
          console.log('--------------------------------------------------------------------------------');
        } else {
          clack.log.warn('No album membership found in database either.');
        }
        clack.outro('Done.');
        return;
      }

      // Display metadata details
      console.log('\nPhoto Details:');
      console.log('--------------------------------------------------------------------------------');
      console.log(`ID:       ${record.media_item_id}`);
      console.log(`Filename: ${record.filename || 'Not downloaded yet (name unknown)'}`);
      console.log(`Type:     ${record.mime_type || 'Unknown'}`);
      console.log(`Status:   ${record.status}`);
      
      let sizeStr = 'Unknown';
      if (record.size !== null && record.size !== undefined && record.size > 0) {
        sizeStr = `${formatBytes(record.size)}`;
      } else if (record.width && record.height) {
        sizeStr = `~ ${formatBytes(Math.round(record.width * record.height * 0.25))} (Estimated via resolution)`;
      }
      console.log(`Size:     ${sizeStr}`);
      console.log(`Resolution: ${record.width && record.height ? `${record.width} x ${record.height}` : 'Unknown'}`);
      console.log(`Date:     ${record.creation_time || 'Unknown'}`);
      console.log(`Source:   ${record.source}`);
      console.log(`Google URL: ${record.google_url || `https://photos.google.com/photo/${record.media_item_id}`}`);
      
      const albumList = albums.length > 0 ? albums.map(a => a.title).join(', ') : 'None (Orphan — not part of any album)';
      console.log(`Albums:   ${albumList}`);
      console.log('--------------------------------------------------------------------------------');

      clack.outro('Done.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nError: ${msg}\n`);
      process.exit(1);
    }
  });
