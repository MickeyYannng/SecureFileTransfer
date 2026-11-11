import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
  quota_bytes: number;
  max_files: number;
  created_at: number;
  updated_at: number;
}

export interface SessionWithUserRow extends UserRow {
  session_id: string;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
  last_seen_at: number;
}

export interface NewUserRow {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role: string;
  quotaBytes: number;
  maxFiles: number;
  now: number;
}

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.connection = new DatabaseSync(databasePath);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  findUserByUsername(username: string): UserRow | undefined {
    return this.connection
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as unknown as UserRow | undefined;
  }

  findUserById(userId: string): UserRow | undefined {
    return this.connection.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as UserRow | undefined;
  }

  insertUser(user: NewUserRow): void {
    this.connection
      .prepare(
        `INSERT INTO users
         (id, username, password_hash, display_name, role, quota_bytes, max_files, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.username,
        user.passwordHash,
        user.displayName,
        user.role,
        user.quotaBytes,
        user.maxFiles,
        user.now,
        user.now,
      );
  }

  updateSeedUser(userId: string, passwordHash: string, role: string, now: number): void {
    this.connection.prepare(
      "UPDATE users SET password_hash = ?, role = ?, updated_at = ? WHERE id = ?",
    ).run(passwordHash, role, now, userId);
  }

  insertSession(input: {
    id: string;
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.connection
      .prepare(
        `INSERT INTO sessions
         (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(input.id, input.tokenHash, input.userId, input.createdAt, input.expiresAt, input.createdAt);
  }

  findSessionByTokenHash(tokenHash: string): SessionWithUserRow | undefined {
    return this.connection
      .prepare(
        `SELECT s.id AS session_id, s.token_hash, s.expires_at, s.revoked_at, s.last_seen_at,
                u.*
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as unknown as SessionWithUserRow | undefined;
  }

  findSessionById(sessionId: string): SessionWithUserRow | undefined {
    return this.connection
      .prepare(
        `SELECT s.id AS session_id, s.token_hash, s.expires_at, s.revoked_at, s.last_seen_at,
                u.*
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as unknown as SessionWithUserRow | undefined;
  }

  touchSession(sessionId: string, now: number): void {
    this.connection.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
  }

  revokeSession(sessionId: string, now: number): void {
    this.connection
      .prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(now, sessionId);
  }

  revokeAllUserSessions(userId: string, now: number): void {
    this.connection
      .prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?")
      .run(now, userId);
  }

  upsertPublicKey(userId: string, publicKeySpki: string, now: number): void {
    this.connection.prepare(
      `INSERT INTO user_public_keys (user_id, public_key_spki, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET public_key_spki = excluded.public_key_spki, updated_at = excluded.updated_at`,
    ).run(userId, publicKeySpki, now, now);
  }

  findPublicKeyByUsername(username: string): { user_id: string; public_key_spki: string } | undefined {
    return this.connection.prepare(
      `SELECT k.user_id, k.public_key_spki FROM user_public_keys k
       JOIN users u ON u.id = k.user_id WHERE u.username = ? COLLATE NOCASE`,
    ).get(username) as { user_id: string; public_key_spki: string } | undefined;
  }

  deleteExpiredSessions(now: number): void {
    this.connection.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL").run(now);
  }

  private migrate(): void {
    this.connection.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
    );
    const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
    const migrationFiles = readdirSync(migrationsDirectory)
      .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();
    const applied = this.connection.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    const record = this.connection.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");

    for (const file of migrationFiles) {
      if (applied.get(file)) continue;
      const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec(sql);
        record.run(file, Date.now());
        this.connection.exec("COMMIT");
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

