import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { readConfig, writeConfig } from '../config.js';
import { doOAuthFlow } from '../oauth.js';
import { launchHeadedBrowser, AUTH_PATH } from '../browser.js';

export const configCommand = new Command('config')
  .description('Set up Google Cloud credentials and authorize API access')
  .action(async () => {
    clack.intro('🕊️  Let My Photos Go — Config');

    // --- Step 1: Google Cloud credentials ---
    const existing = readConfig();

    if (!existing) {
      clack.log.info(
        'You need a Google Cloud OAuth2 client to use the Photos Library API.\n' +
        '  1. Go to https://console.cloud.google.com/\n' +
        '  2. Create a project and enable the "Photos Library API"\n' +
        '  3. Create an OAuth2 credential (type: Desktop app)\n' +
        '  4. Copy the Client ID and Client Secret below'
      );
    }

    const clientIdInput = await clack.text({
      message: `Google OAuth2 Client ID${existing ? ` (${existing.clientId})` : ''}:`,
      placeholder: existing ? '(press Enter to keep current)' : '',
      validate: (v) => (!v.trim() && !existing ? 'Required' : undefined),
    });
    if (clack.isCancel(clientIdInput)) { clack.cancel('Cancelled.'); process.exit(0); }

    const clientSecretInput = await clack.password({
      message: `Google OAuth2 Client Secret${existing ? ' (press Enter to keep current)' : ''}:`,
      validate: (v) => (!v.trim() && !existing ? 'Required' : undefined),
    });
    if (clack.isCancel(clientSecretInput)) { clack.cancel('Cancelled.'); process.exit(0); }

    const config = {
      clientId: clientIdInput.trim() || existing!.clientId,
      clientSecret: clientSecretInput.trim() || existing!.clientSecret,
    };
    writeConfig(config);
    clack.log.success('Credentials saved to config.json');

    // --- Step 2: OAuth2 flow via Playwright (for API access) ---
    const hasSession = fs.existsSync(AUTH_PATH);
    const browserSpinner = clack.spinner();
    browserSpinner.start('Launching browser for Google API authorization…');
    const { browser, context } = await launchHeadedBrowser(hasSession ? AUTH_PATH : undefined);
    const page = await context.newPage();
    browserSpinner.stop('Browser launched.');

    clack.log.step('Authorize access to your Google Photos library in the browser window…');

    try {
      await doOAuthFlow(config.clientId, config.clientSecret, (url) => page.goto(url).then(() => {}));
      clack.log.success('API authorization complete. Tokens saved to tokens.json');
    } catch (err) {
      clack.log.error(`API authorization failed: ${String(err)}`);
      await browser.close();
      process.exit(1);
    }

    await browser.close();

    clack.outro("API access configured! Run `lmpg flee` to start downloading your photos. 🎉");
  });
