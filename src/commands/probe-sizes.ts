import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { getDb, updatePhotoMetadata } from '../db';
import type { PhotoRecord } from '../db';
import { launchHeadlessBrowser, saveSession } from '../browser';
import { getAuthPath } from '../paths';
import { wrapAction } from '../util';
import * as fs from 'fs';
import * as https from 'https';
import { URL } from 'url';

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function parseInfoPanel(text: string): { quotaBytes: number; quality: 'original' | 'saver' | 'shared' | 'unknown' } {
  const clean = text.replace(/\u00a0/g, ' '); // replace non-breaking spaces
  
  // 1. Check for 0 quota (shared / doesn't occupy storage)
  const isSharedOrZeroQuota = 
    clean.includes("n'occupe pas d'espace") || 
    clean.includes("does not occupy storage") ||
    clean.includes("occupies no storage");
    
  if (isSharedOrZeroQuota) {
    return { quotaBytes: 0, quality: 'shared' };
  }
  
  // 2. Extract quality type
  let quality: 'original' | 'saver' | 'shared' | 'unknown' = 'unknown';
  if (clean.includes("d'origine") || clean.includes("original quality") || clean.includes("Original quality")) {
    quality = 'original';
  } else if (clean.includes("Économiseur") || clean.includes("Storage saver") || clean.includes("Storage Saver")) {
    quality = 'saver';
  }
  
  // 3. Extract quota size
  // Match "Saved (X MB)" or "Sauvegardé (X Mo)"
  const match = clean.match(/(?:Saved|Sauvegardé)\s*\(([\d,.]+)\s*([MGTK]o|[MGTK]B|Bytes|octets)\)/i);
  if (match) {
    const val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toLowerCase();
    let multiplier = 1;
    if (unit.startsWith('k')) multiplier = 1024;
    else if (unit.startsWith('m')) multiplier = 1024 * 1024;
    else if (unit.startsWith('g')) multiplier = 1024 * 1024 * 1024;
    else if (unit.startsWith('t')) multiplier = 1024 * 1024 * 1024 * 1024;
    
    return { quotaBytes: Math.round(val * multiplier), quality };
  }
  
  return { quotaBytes: -1, quality };
}

function fetchHeaders(urlStr: string, cookieHeader: string, userAgent: string, maxRedirects = 5): Promise<{ size: number; filename: string | null }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Too many redirects'));
    }
    
    const parsed = new URL(urlStr);
    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': userAgent,
        'Accept': '*/*',
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        res.destroy();
        resolve(fetchHeaders(nextUrl, cookieHeader, userAgent, maxRedirects - 1));
        return;
      }
      
      const len = res.headers['content-length'];
      const size = len ? parseInt(len, 10) : 0;
      
      const disp = res.headers['content-disposition'];
      let filename: string | null = null;
      if (disp && disp.includes('filename=')) {
        const match = disp.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }
      
      res.destroy();
      resolve({ size, filename });
    });
    
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export const probeSizesCommand = new Command('probe-sizes')
  .description('Probe the exact file sizes and names of your largest pending photos without downloading them')
  .option('-l, --limit <n>', 'Maximum number of items to probe', (val) => parseInt(val, 10), 200)
  .option('-c, --concurrency <n>', 'Number of parallel page threads', (val) => parseInt(val, 10), 3)
  .option('-f, --force', 'Force probing even if quota size is already cached in the database')
  .option('--only-owned', 'Only probe files uploaded by you (excluding shared items)')
  .option('--inspect', 'Open visible browser (for debugging)')
  .action(
    wrapAction(async (options: { limit: number; concurrency: number; force?: boolean; onlyOwned?: boolean; inspect?: boolean }, cmd: Command) => {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);

      clack.intro('🕊️  Let My Photos Go — Probe Exact Sizes');

      if (!fs.existsSync(getAuthPath())) {
        clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
        process.exit(1);
      }

      let db;
      try {
        db = getDb();
      } catch {
        clack.log.error(`No database found. Run \`${lmpg('enumerate')}\` first.`);
        process.exit(1);
      }

      // Find user's own token if --only-owned is requested
      let ownToken: string | null = null;
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
        } catch {}
      }

      // Query ALL pending orphan items sorted by size DESC
      let query = `
        SELECT p.* FROM photos p
        LEFT JOIN album_photos ap ON p.media_item_id = ap.media_item_id
        WHERE ap.media_item_id IS NULL
          AND p.status != 'downloaded'
      `;
      const queryParams: any[] = [];

      if (ownToken) {
        query += ` AND (p.owner_token = ? OR p.owner_token IS NULL OR p.owner_token = '')`;
        queryParams.push(ownToken);
      }

      query += ` ORDER BY size DESC`;

      let allPending: PhotoRecord[];
      try {
        allPending = db.prepare(query).all(...queryParams) as PhotoRecord[];
      } catch (err) {
        clack.log.error(`Database query failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (allPending.length === 0) {
        clack.log.success('No pending files found in the database!');
        clack.outro('Done.');
        return;
      }

      // Partition list into skipped vs to-probe (Option B: probe exactly N new ones)
      const toProbe: PhotoRecord[] = [];
      let skippedCount = 0;
      const skippedNames: string[] = [];

      for (const item of allPending) {
        const isProbed = item.quota_bytes !== null && item.quota_bytes !== undefined;
        if (isProbed && !options.force) {
          skippedCount++;
          if (skippedNames.length < 5) {
            skippedNames.push(item.filename || `id:${item.media_item_id}`);
          }
        } else {
          if (toProbe.length < options.limit) {
            toProbe.push(item);
          } else {
            break;
          }
        }
      }

      if (skippedCount > 0) {
        clack.log.info(
          `Skipping ${skippedCount} already-probed items: ${skippedNames.join(', ')}${
            skippedCount > 5 ? `... and ${skippedCount - 5} more` : ''
          }`
        );
      }

      if (toProbe.length === 0) {
        clack.log.success('All matching files have already been probed! Use --force to re-probe.');
        clack.outro('Done.');
        return;
      }

      const total = toProbe.length;
      clack.log.info(`Probing exact size and name for the next ${total} unprobed items...`);

      const spinner = clack.spinner();
      spinner.start(`[0/${total}] Launching browser...`);

      const { browser, context } = await launchHeadlessBrowser({
        inspect: options.inspect,
      });

      spinner.message(`[0/${total}] Starting size probing...`);

      let probed = 0;
      let failed = 0;
      let sessionExpired = false;
      let shuttingDown = false;

      // Handle interrupts
      const onSigInt = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        clack.log.warn('\nStopping after current requests complete...');
      };
      process.on('SIGINT', onSigInt);

      const worker = async (photo: PhotoRecord) => {
        if (sessionExpired || shuttingDown) return;

        const displayName = photo.filename || `id:${photo.media_item_id}`;

        while (true) {
          const page = await context.newPage();
          let shouldRetry = false;

          try {
            spinner.message(`[${probed}/${total}] ➜ Probing: ${displayName}...`);

            const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
            downloadPromise.catch(() => {});

            await page.goto(photo.google_url ?? `https://photos.google.com/photo/${photo.media_item_id}`, {
              waitUntil: 'load',
              timeout: 30000,
            });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

            if (!page.url().startsWith('https://photos.google.com/')) {
              if (!sessionExpired) {
                sessionExpired = true;
                clack.log.error(`Session expired — run \`${lmpg('auth')}\` to sign in again.`);
              }
              return;
            }

            // Open Info panel
            await page.keyboard.press('KeyI');
            await page.waitForTimeout(1000);

            // Read Info panel
            const infoText = await page.evaluate(() => {
              const panel = document.querySelector('[role="complementary"]') || document.body;
              return panel ? (panel as any).innerText || '' : '';
            });
            const parsedInfo = parseInfoPanel(infoText);

            // Trigger download shortcut
            await page.keyboard.press('Shift+KeyD');

            const download = await downloadPromise;
            const url = download.url();
            const suggestedFilename = download.suggestedFilename();
            await download.cancel(); // Abort file download instantly

            // Fetch headers using context cookies
            const cookies = await context.cookies();
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const userAgent = await page.evaluate(() => navigator.userAgent);

            const { size, filename } = await fetchHeaders(url, cookieString, userAgent);

            const finalFilename = filename || suggestedFilename || `${photo.media_item_id}.jpg`;
            
            // Save to database (keeps status as pending)
            updatePhotoMetadata(
              photo.media_item_id, 
              size, 
              finalFilename, 
              parsedInfo.quotaBytes >= 0 ? parsedInfo.quotaBytes : null,
              parsedInfo.quality
            );

            probed++;
            let quotaDisplay = '';
            if (parsedInfo.quotaBytes === 0) {
              quotaDisplay = 'Quota: 0 MB (Shared)';
            } else if (parsedInfo.quotaBytes > 0) {
              quotaDisplay = `Quota: ${formatBytes(parsedInfo.quotaBytes)} (${parsedInfo.quality})`;
            } else {
              quotaDisplay = 'Quota: Unknown';
            }

            spinner.message(
              `[${probed}/${total}] ✓ Probed: ${finalFilename} (Size: ${formatBytes(size)} | ${quotaDisplay})`
            );
          } catch (err: any) {
            if (page.isClosed()) {
              shouldRetry = true;
              continue;
            }
            failed++;
            clack.log.warn(`✗ Failed to probe ID ${photo.media_item_id}: ${err.message}`);
          } finally {
            await page.close();
          }
          break;
        }
      };

      // Run concurrency threads
      const concurrency = Math.min(options.concurrency, toProbe.length);
      
      let i = 0;
      async function next(): Promise<void> {
        while (i < toProbe.length && !sessionExpired && !shuttingDown) {
          const item = toProbe[i++];
          await worker(item);
        }
      }
      await Promise.all(Array.from({ length: concurrency }, next));

      spinner.stop(`Probed sizes for ${probed} items.${failed > 0 ? ` (${failed} failed)` : ''}`);

      await saveSession(context);
      await browser.close();
      process.off('SIGINT', onSigInt);

      clack.outro('Done.');
    })
  );
