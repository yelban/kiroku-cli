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
