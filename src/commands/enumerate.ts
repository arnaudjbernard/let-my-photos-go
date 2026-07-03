import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { wrapAction } from '../util';
import * as fs from 'fs';
import { launchHeadlessBrowser, saveSession } from '../browser';
import { getAuthPath } from '../paths';
import { enumerateAllMediaItems } from '../api';
import { upsertPhoto, getStats, getDb } from '../db';

export const enumerateCommand = new Command('enumerate')
  .description('Scan Google Photos and populate the local database with photo metadata')
  .action(wrapAction(async (_options: Record<string, never>, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Enumerate');

    if (!fs.existsSync(getAuthPath())) {
      clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
      process.exit(1);
    }

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Scanning your photos…');
    let apiCount = 0;
    const activeIds = new Set<string>();
    let completed = false;
    try {
      for await (const item of enumerateAllMediaItems(context, n => {
        spinner.message(`Scanning your photos… (${n} found so far)`);
        apiCount = n;
      })) {
        activeIds.add(item.id);
        const creationTime = item.creationTime ? new Date(item.creationTime).toISOString() : null;
        const mimeType = item.durationMs ? 'video' : 'image';
        upsertPhoto(
          item.id,
          item.productUrl,
          creationTime,
          item.width,
          item.height,
          item.size,
          item.ownerToken,
          item.durationMs,
          mimeType
        );
      }
      completed = true;
      spinner.stop('Scanning complete.');
    } catch (err) {
      spinner.stop('Failed to scan photos.');
      clack.log.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }

    if (completed) {
      spinner.start('Cleaning up deleted items from database…');
      let deletedCount = 0;
      try {
        const db = getDb();
        db.transaction(() => {
          db.exec(`CREATE TEMP TABLE temp_active_ids (id TEXT PRIMARY KEY)`);
          const insert = db.prepare(`INSERT OR IGNORE INTO temp_active_ids (id) VALUES (?)`);
          for (const id of activeIds) {
            insert.run(id);
          }
          deletedCount = (db.prepare(`
            DELETE FROM photos 
            WHERE source = 'timeline' 
              AND media_item_id NOT IN (SELECT id FROM temp_active_ids)
          `).run() as { changes: number }).changes;
          db.exec(`DROP TABLE temp_active_ids`);
        })();
      } catch (dbErr) {
        clack.log.warn(`Database cleanup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
      }
      spinner.stop('Cleanup complete.');
      if (deletedCount > 0) {
        clack.log.info(`Removed ${deletedCount.toLocaleString()} deleted/trashed items from database.`);
      }
    }

    const { total } = getStats();
    const dupes = apiCount - total;
    clack.log.info(
      `Found and indexed ${total.toLocaleString()} photos.${dupes > 0 ? ` (${dupes.toLocaleString()} duplicates skipped)` : ''}`,
    );

    await saveSession(context);
    await browser.close();

    clack.outro(`Done. Run \`${lmpg('flee')}\` to download your photos.`);
  }));
