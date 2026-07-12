import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing redact
vi.mock('../../src/shared/config.js', () => ({
  loadConfig: () => ({
    proxy: {
      dlp: {
        enabled: true,
        rules: {
          awsAccessKey: true,
          anthropicApiKey: true,
          openaiApiKey: true,
          githubPat: true,
          githubFineGrainedPat: true,
          slackToken: true,
          privateKeyBlock: true,
          jwt: true,
        },
      },
    },
  }),
}));

const { redact, redactSecrets, containsSecret } = await import('../../src/shared/redact.js');

describe('redact', () => {
  // ── AWS Access Key ──
  describe('awsAccessKey', () => {
    it('should redact valid AKIA key', () => {
      const r = redact('key is AKIAIOSFODNN7EXAMPLE here');
      expect(r.text).toContain('[REDACTED]');
      expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(r.rulesTriggered).toContain('awsAccessKey');
    });

    it('should redact AKIA inside base64-like context', () => {
      const r = redact('base64: AKIAQWERTYUIOP123456');
      expect(r.text).toContain('[REDACTED]');
    });

    it('should not redact AKIA embedded in longer base64 string', () => {
      // AKIA preceded by alphanumeric → negative lookbehind prevents match
      const r = redact('data=xAKIAIOSFODNN7EXAMPLE');
      expect(r.rulesTriggered).not.toContain('awsAccessKey');
    });
  });

  // ── Anthropic API Key ──
  describe('anthropicApiKey', () => {
    it('should redact sk-ant- keys', () => {
      const key = 'sk-ant-' + 'a'.repeat(40);
      const r = redact(`token: ${key}`);
      expect(r.text).toContain('[REDACTED]');
      expect(r.rulesTriggered).toContain('anthropicApiKey');
    });
  });

  // ── OpenAI API Key ──
  describe('openaiApiKey', () => {
    it('should redact long sk- keys', () => {
      const key = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);
      const r = redact(`openai ${key} end`);
      expect(r.text).toContain('[REDACTED]');
      expect(r.rulesTriggered).toContain('openaiApiKey');
    });

    it('should not redact short sk- slug', () => {
      // sk-proj-2024 is only 12 chars after "sk-", less than 20 minimum
      const r = redact('sk-proj-2024-settings');
      expect(r.rulesTriggered).not.toContain('openaiApiKey');
    });
  });

  // ── GitHub PAT ──
  describe('githubPat', () => {
    it('should redact ghp_ token with 36+ chars', () => {
      const key = 'ghp_' + 'A'.repeat(36);
      const r = redact(`gh: ${key}`);
      expect(r.text).toContain('[REDACTED]');
      expect(r.rulesTriggered).toContain('githubPat');
    });

    it('should not redact short ghp_ token', () => {
      const r = redact('ghp_short');
      expect(r.rulesTriggered).not.toContain('githubPat');
    });
  });

  // ── Slack Token ──
  describe('slackToken', () => {
    it('should redact xoxb- token', () => {
      const key = 'xoxb-' + '1234567890'.repeat(3);
      const r = redact(`slack ${key}`);
      expect(r.text).toContain('[REDACTED]');
      expect(r.rulesTriggered).toContain('slackToken');
    });

    it('should redact xoxp- token', () => {
      const key = 'xoxp-' + 'abcdefghij'.repeat(2);
      const r = redact(`token=${key}`);
      expect(r.text).toContain('[REDACTED]');
    });
  });

  // ── General ──
  it('should return unmodified text when nothing matches', () => {
    const r = redact('Hello world, no secrets here');
    expect(r.text).toBe('Hello world, no secrets here');
    expect(r.applied).toBe(false);
    expect(r.rulesTriggered).toEqual([]);
  });

  it('should redact multiple keys in one string', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const ghp = 'ghp_' + 'B'.repeat(36);
    // Use space before keys (= is in the negative lookbehind set)
    const r = redact(`aws ${aws} gh ${ghp}`);
    expect(r.rulesTriggered).toContain('awsAccessKey');
    expect(r.rulesTriggered).toContain('githubPat');
    expect(r.text).not.toContain(aws);
    expect(r.text).not.toContain(ghp);
  });
});

describe('G16 additions', () => {
  const projKey = `sk-proj-${'a1B2'.repeat(10)}`;
  const finePat = `github_pat_${'X9'.repeat(15)}`;
  const jwtToken = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.${'s'.repeat(16)}`;
  const pemBlock = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';

  it('redacts sk-proj- keys (the pre-G16 regex let them through)', () => {
    const r = redact(`token ${projKey} in env`);
    expect(r.text).not.toContain(projKey);
    expect(r.rulesTriggered).toContain('openaiApiKey');
  });

  it('redacts fine-grained GitHub PATs', () => {
    const r = redact(`use ${finePat} here`);
    expect(r.text).not.toContain(finePat);
    expect(r.rulesTriggered).toContain('githubFineGrainedPat');
  });

  it('redacts JWTs and PEM private key blocks', () => {
    const r = redact(`jwt ${jwtToken} and\n${pemBlock}`);
    expect(r.text).not.toContain(jwtToken);
    expect(r.text).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('redactSecrets scrubs unconditionally without config', () => {
    const scrubbed = redactSecrets(`ghp_${'A'.repeat(36)} and ${projKey}`);
    expect(scrubbed).not.toContain('ghp_A');
    expect(scrubbed).not.toContain(projKey);
    expect(scrubbed).toContain('[REDACTED]');
    expect(redactSecrets('plain text stays')).toBe('plain text stays');
  });

  it('containsSecret detects without mutating', () => {
    expect(containsSecret(`deploy with ghp_${'B'.repeat(36)}`)).toBe(true);
    expect(containsSecret('uses GitHub PAT (value withheld)')).toBe(false);
  });
});
