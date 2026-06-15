import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import { launchHeadlessBrowser, isSessionValid, AUTH_PATH } from '../browser.js';
import { enumerateAllMediaItems } from '../api.js';
import { upsertPhoto, markDownloaded, markFailed, getPendingPhotos } from '../db.js';
import { readConfig } from '../config.js';

export const fleeCommand = new Command('flee')
  .description('Download all your Google Photos with full metadata')
  .option('--resume', 'Skip photos already downloaded', false)
  .option('--output <dir>', 'Output directory', './photos')
  .action(async (options: { resume: boolean; output: string }) => {
    clack.intro('🕊️  Let My Photos Go — Flee!');

    const config = readConfig();
    if (!config) {
      clack.log.error('No config.json found. Run `lmpg auth` first to set up credentials.');
      process.exit(1);
    }

    if (!fs.existsSync(AUTH_PATH)) {
      clack.log.error('No auth.json found. Run `lmpg auth` first to log in.');
      process.exit(1);
    }

    const outputDir = path.resolve(process.cwd(), options.output);
    fs.mkdirSync(outputDir, { recursive: true });

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Checking session validity…');
    const valid = await isSessionValid(context);
    if (!valid) {
      spinner.stop('Session expired or invalid.');
      clack.log.error('Your session has expired. Run `lmpg auth` to log in again.');
      await browser.close();
      process.exit(1);
    }
    spinner.stop('Session is valid.');

    // Enumerate all media items from the Google Photos API
    spinner.start('Enumerating your photos from Google Photos API…');
    let enumCount = 0;
    try {
      for await (const item of enumerateAllMediaItems(config, (n) => {
        spinner.message(`Enumerating photos… (${n} found so far)`);
        enumCount = n;
      })) {
        upsertPhoto(item.id, item.filename, item.productUrl);
      }
    } catch (err) {
      spinner.stop('Failed to enumerate photos.');
      clack.log.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop(`Found ${enumCount} photos total.`);

    const pending = getPendingPhotos();
    if (pending.length === 0) {
      clack.log.success('All photos are already downloaded!');
      await browser.close();
      clack.outro('Nothing left to do. 🎉');
      return;
    }

    clack.log.info(`Downloading ${pending.length} photos to ${outputDir}…`);

    let downloaded = 0;
    let failed = 0;

    for (const photo of pending) {
      const page = await context.newPage();
      try {
        // Set up download handling before navigating
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

        await page.goto(photo.google_url ?? `https://photos.google.com/photo/${photo.media_item_id}`, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });

        // Trigger download via keyboard shortcut (Shift+D in Google Photos)
        await page.keyboard.press('Shift+KeyD');

        const download = await downloadPromise;
        const destPath = path.join(outputDir, photo.filename);
        await download.saveAs(destPath);

        markDownloaded(photo.media_item_id);
        downloaded++;
        clack.log.step(`[${downloaded}/${pending.length}] ✓ ${photo.filename}`);
      } catch (err) {
        markFailed(photo.media_item_id);
        failed++;
        clack.log.warn(`[${downloaded + failed}/${pending.length}] ✗ ${photo.filename}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await page.close();
      }
    }

    await browser.close();

    clack.outro(
      `Done! Downloaded ${downloaded} photos. ${failed > 0 ? `${failed} failed (run again to retry).` : '🎉'}`
    );
  });
