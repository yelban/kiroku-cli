// SQL deny patterns for sql-sandbox (regex array)
export const SQL_DENY_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|CREATE|TRIGGER|LOAD_EXTENSION)\b/i,
];

// DLP regex rules for sensitive data redaction
export const DLP_RULES = {
  awsAccessKey: /(?<![A-Za-z0-9/+=])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9/+=])/g,
  anthropicApiKey: /(?<![A-Za-z0-9_-])(sk-ant-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
  openaiApiKey: /(?<![A-Za-z0-9_-])(sk-[A-Za-z0-9]{20,})(?![A-Za-z0-9_-])/g,
  githubPat: /(?<![A-Za-z0-9_])(ghp_[A-Za-z0-9]{36,})(?![A-Za-z0-9_])/g,
  slackToken: /(?<![A-Za-z0-9_-])(xox[bpras]-[A-Za-z0-9-]{10,})(?![A-Za-z0-9_-])/g,
};

// SQLite PRAGMA settings
export const SQLITE_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA cache_size = -20000',
];

// SQL allowed statement prefixes
export const SQL_ALLOWED_PREFIXES = ['SELECT', 'WITH', 'EXPLAIN'];

// Freemium limits (fallback when config not set)
export const FREEMIUM_FACT_LIMIT = 500;
export const FREEMIUM_DAILY_EXTRACT_LIMIT = 50;
