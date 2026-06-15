import Database from 'better-sqlite3';
import * as path from 'path';

export type PhotoStatus = 'pending' | 'downloaded' | 'failed';

export interface PhotoRecord {
  media_item_id: string;
  filename: string;
  status: PhotoStatus;
  downloaded_at: string | null;
  google_url: string | null;
  created_at: string;
}

const DB_PATH = path.resolve(process.cwd(), 'photos.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      media_item_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      downloaded_at TEXT,
      google_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function upsertPhoto(
  mediaItemId: string,
  filename: string,
  googleUrl: string | null
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO photos (media_item_id, filename, google_url)
    VALUES (?, ?, ?)
    ON CONFLICT (media_item_id) DO NOTHING
  `).run(mediaItemId, filename, googleUrl);
}

export function markDownloaded(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE photos SET status = 'downloaded', downloaded_at = datetime('now')
    WHERE media_item_id = ?
  `).run(mediaItemId);
}

export function markFailed(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE photos SET status = 'failed'
    WHERE media_item_id = ?
  `).run(mediaItemId);
}

export function getPendingPhotos(): PhotoRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM photos WHERE status != 'downloaded' ORDER BY created_at ASC
  `).all() as PhotoRecord[];
}

export function getStats(): { total: number; downloaded: number; failed: number; pending: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM photos GROUP BY status
  `).all() as { status: string; count: number }[];

  const stats = { total: 0, downloaded: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.status === 'downloaded') stats.downloaded = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
    else if (row.status === 'pending') stats.pending = row.count;
  }
  return stats;
}
