import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const databasePath = process.env.DB_PATH || '/var/lib/batty-club/batty.sqlite';
const backupDirectory = process.env.BACKUP_DIR || '/var/backups/batty-club';
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(':', '-');
const target = path.join(backupDirectory, `batty-${stamp}.sqlite`);
const database = new DatabaseSync(databasePath, { readOnly: true });
try { await backup(database, target); chmodSync(target, 0o600); console.log(`SQLite backup created: ${target}`); }
finally { database.close(); }
