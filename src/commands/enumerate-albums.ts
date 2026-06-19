import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { launchHeadlessBrowser, saveSession } from '../browser.js';
import { getAuthPath } from '../paths.js';
import { readConfig } from '../config.js';
import { extractBatchParams, enumerateAllAlbums, fetchAlbumPhotoSamples, type Album } from '../api.js';

export const enumerateAlbumsCommand = new Command('enumerate-albums')
  .description('Diagnostic: list all albums with photo ownership breakdown from Google Photos')
  .action(async (_options: Record<string, unknown>, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Enumerate Albums');

    if (!fs.existsSync(getAuthPath())) {
      clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
      process.exit(1);
    }

    const config = readConfig();
    const googleUserToken = config?.googleUserToken ?? null;
    if (!googleUserToken) {
      clack.log.warn(`Google user token not found. Re-run \`${lmpg('auth')}\` to enable ownership detection.`);
    }

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Extracting session params…');
    let params;
    try {
      params = await extractBatchParams(context);
    } catch (err) {
      spinner.stop('Failed to extract session params.');
      clack.log.error(`${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop('Session ready.');

    spinner.start('Scanning album list…');
    const albums: Album[] = [];
    try {
      for await (const album of enumerateAllAlbums(context, params)) {
        albums.push(album);
        spinner.message(`Scanning album list… (${albums.length} found)`);
      }
    } catch (err) {
      spinner.stop('Failed to scan albums.');
      clack.log.error(`${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop(`Found ${albums.length} albums.`);

    spinner.start('Fetching photo attribution…');
    for (let i = 0; i < albums.length; i++) {
      const album = albums[i];
      spinner.message(`[${i + 1}/${albums.length}] ${album.title}…`);

      const samples = await fetchAlbumPhotoSamples(context, params, album);

      // Build token → display name map from album members
      const tokenToName = new Map<string, string>();
      for (const member of album.members) {
        const name = member.token === googleUserToken ? 'you' : (member.displayName ?? member.userId);
        tokenToName.set(member.token, name);
      }

      // Count photos per uploader token
      const counts = new Map<string | null, number>();
      for (const s of samples) {
        counts.set(s.uploaderId, (counts.get(s.uploaderId) ?? 0) + 1);
      }

      const header = `"${album.title}"  ${album.photoCount} photos`;

      if (counts.size === 0) {
        clack.log.info(`${header}  — all yours`);
        continue;
      }

      const isAllYours = counts.size === 1 && counts.has(googleUserToken);
      if (isAllYours) {
        clack.log.info(`${header}  — all yours`);
        continue;
      }

      const rows = [...counts.entries()]
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([token, count]) => {
          const name = token ? (tokenToName.get(token) ?? token.slice(0, 20) + '…') : '?';
          return `  ${count} by ${name}`;
        });
      clack.log.info(`${header}\n${rows.join('\n')}`);
    }
    spinner.stop('Done.');

    await saveSession(context);
    await browser.close();

    clack.outro(`${albums.length} albums listed.`);
  });
