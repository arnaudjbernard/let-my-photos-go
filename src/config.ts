import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  clientId: string;
  clientSecret: string;
}

export const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
