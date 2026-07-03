import { chromium, Browser, BrowserContext } from 'playwright';
import { getAuthPath } from './paths';

export async function launchHeadedBrowser(
  storageState?: string,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  return { browser, context };
}

export async function launchHeadlessBrowser(
  opts: { inspect?: boolean } = {},
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: !opts.inspect,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    storageState: getAuthPath(),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  return { browser, context };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: getAuthPath() });
}

export async function isSessionValid(context: BrowserContext): Promise<boolean> {
  // Cookie check — no navigation, no flaky URL assertions
  const cookies = await context.cookies(['https://google.com', 'https://photos.google.com']);
  return cookies.some(c => ['SID', 'SSID', '__Secure-3PSID', 'SAPISID'].includes(c.name));
}
