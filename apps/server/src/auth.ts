import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import type { PublicUser } from "@sft/protocol";
import { AppDatabase, type SessionWithUserRow, type UserRow } from "./database.js";

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

export interface AuthOptions {
  sessionTtlMs: number;
  defaultQuotaBytes: number;
  defaultMaxFiles: number;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: PublicUser;
  expiresAt: number;
}

export interface LoginResult extends AuthenticatedSession {
  token: string;
}

export class AuthFailure extends Error {
  constructor(
    readonly code: "INVALID_CREDENTIALS" | "SESSION_EXPIRED" | "SESSION_REVOKED" | "AUTH_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export class AuthService {
  private constructor(
    private readonly database: AppDatabase,
    private readonly options: AuthOptions,
    private readonly dummyHash: string,
  ) {}

  static async create(database: AppDatabase, options: AuthOptions): Promise<AuthService> {
    const dummyHash = await argon2.hash(randomBytes(32), ARGON2_OPTIONS);
    return new AuthService(database, options, dummyHash);
  }

  async createUser(input: {
    id?: string;
    username: string;
    password: string;
    displayName: string;
    role?: string;
    quotaBytes?: number;
    maxFiles?: number;
  }): Promise<{ created: boolean; user: PublicUser }> {
    validateUsername(input.username);
    validatePassword(input.password);
    const existing = this.database.findUserByUsername(input.username);
    if (existing) return { created: false, user: toPublicUser(existing) };
    const now = Date.now();
    const row = {
      id: input.id ?? randomUUID(),
      username: input.username,
      passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS),
      displayName: validateDisplayName(input.displayName),
      role: input.role ?? "user",
      quotaBytes: input.quotaBytes ?? this.options.defaultQuotaBytes,
      maxFiles: input.maxFiles ?? this.options.defaultMaxFiles,
      now,
    };
    this.database.insertUser(row);
    const user = this.database.findUserById(row.id);
    if (!user) throw new Error("created user could not be loaded");
    return { created: true, user: toPublicUser(user) };
  }

  async login(username: string, password: string): Promise<LoginResult> {
    if (typeof username !== "string" || username.length > 128 || typeof password !== "string" || password.length > 512) {
      await argon2.verify(this.dummyHash, "invalid-input");
      throw new AuthFailure("INVALID_CREDENTIALS", "invalid username or password");
    }
    const user = this.database.findUserByUsername(username);
    const passwordHash = user?.password_hash ?? this.dummyHash;
    let valid = false;
    try {
      valid = await argon2.verify(passwordHash, password);
    } catch {
      valid = false;
    }
    if (!user || !valid) throw new AuthFailure("INVALID_CREDENTIALS", "invalid username or password");

    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const sessionId = randomUUID();
    const expiresAt = now + this.options.sessionTtlMs;
    this.database.insertSession({
      id: sessionId,
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now,
      expiresAt,
    });
    return { token, sessionId, expiresAt, user: toPublicUser(user) };
  }

  authenticateToken(token: string): AuthenticatedSession {
    if (!isTokenFormatValid(token)) throw new AuthFailure("INVALID_CREDENTIALS", "invalid session token");
    const row = this.database.findSessionByTokenHash(hashToken(token));
    return this.validateSessionRow(row);
  }

  validateSession(sessionId: string | undefined): AuthenticatedSession {
    if (!sessionId) throw new AuthFailure("AUTH_REQUIRED", "authentication is required");
    return this.validateSessionRow(this.database.findSessionById(sessionId));
  }

  logout(sessionId: string): void {
    this.database.revokeSession(sessionId, Date.now());
  }

  private validateSessionRow(row: SessionWithUserRow | undefined): AuthenticatedSession {
    if (!row) throw new AuthFailure("INVALID_CREDENTIALS", "invalid session token");
    if (row.revoked_at !== null) throw new AuthFailure("SESSION_REVOKED", "session has been revoked");
    const now = Date.now();
    if (row.expires_at <= now) throw new AuthFailure("SESSION_EXPIRED", "session has expired");
    this.database.touchSession(row.session_id, now);
    return { sessionId: row.session_id, expiresAt: row.expires_at, user: toPublicUser(row) };
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isTokenFormatValid(token: string): boolean {
  return token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token);
}

function validateUsername(username: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{2,31}$/.test(username)) throw new Error("username format is invalid");
}

function validatePassword(password: string): void {
  if (password.length < 10 || password.length > 256) throw new Error("password must contain 10 to 256 characters");
}

function validateDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length < 1 || normalized.length > 64) throw new Error("display name is invalid");
  return normalized;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    quotaBytes: row.quota_bytes,
    maxFiles: row.max_files,
  };
}

