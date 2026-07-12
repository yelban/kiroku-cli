import { DLP_RULES } from './constants.js';
import { loadConfig } from './config.js';

export function redact(text) {
  const config = loadConfig();
  if (!config.proxy.dlp.enabled) return { text, applied: false, rulesTriggered: [] };

  const enabledRules = config.proxy.dlp.rules;
  const rulesTriggered = [];
  let redacted = text;

  for (const [ruleName, pattern] of Object.entries(DLP_RULES)) {
    if (!enabledRules[ruleName]) continue;
    // Clone regex to reset lastIndex
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(redacted)) {
      rulesTriggered.push(ruleName);
      const re2 = new RegExp(pattern.source, pattern.flags);
      redacted = redacted.replace(re2, '[REDACTED]');
    }
  }

  return {
    text: redacted,
    applied: rulesTriggered.length > 0,
    rulesTriggered,
  };
}

// Unconditional secret scrub for memory OUTPUT surfaces (brief, search,
// memory_about, sql_readonly cells). Unlike redact(), this ignores config —
// the output floor has no escape hatch, because it is the only defense for
// secrets that already made it into the store (G16).
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const pattern of Object.values(DLP_RULES)) {
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return Object.values(DLP_RULES).some(pattern => {
    const re = new RegExp(pattern.source, pattern.flags);
    return re.test(text);
  });
}
