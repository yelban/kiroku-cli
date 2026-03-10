import { describe, it, expect } from 'vitest';
import { classify } from '../../src/proxy/classifier.js';

describe('classify', () => {
  it('should classify title generation', () => {
    const r = classify({ system: 'Generate a concise title for this conversation' });
    expect(r.intent).toBe('title_generation');
    expect(r.isMainline).toBe(false);
  });

  it('should classify suggestion mode', () => {
    const r = classify({
      system: 'test',
      messages: [{ role: 'user', content: '[SUGGESTION MODE: abc] hello' }],
    });
    expect(r.intent).toBe('suggestion');
    expect(r.isMainline).toBe(false);
  });

  it('should classify tool search', () => {
    const r = classify({ system: 'Tool Search mode enabled' });
    expect(r.intent).toBe('tool_search');
    expect(r.isMainline).toBe(false);
  });

  it('should classify mainline CLI', () => {
    const r = classify({ system: 'cc_entrypoint=cli and other stuff' });
    expect(r.intent).toBe('mainline');
    expect(r.isMainline).toBe(true);
  });

  it('should classify other for unknown patterns', () => {
    const r = classify({ system: 'You are a helpful assistant', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.intent).toBe('other');
    expect(r.isMainline).toBe(false);
  });

  it('should handle null/undefined input', () => {
    expect(classify(null).intent).toBe('unknown');
    expect(classify(undefined).intent).toBe('unknown');
  });

  it('should handle empty messages array', () => {
    const r = classify({ system: 'test', messages: [] });
    expect(r.intent).toBe('other');
  });

  it('should handle malformed JSON (no system)', () => {
    const r = classify({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.intent).toBe('other');
  });

  it('should handle system as array', () => {
    const r = classify({
      system: [{ text: 'Generate a concise title' }],
      messages: [],
    });
    expect(r.intent).toBe('title_generation');
  });

  it('should handle user content as array', () => {
    const r = classify({
      system: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: '[SUGGESTION MODE: x] hi' }] }],
    });
    expect(r.intent).toBe('suggestion');
  });

  it('should strip system-reminder tags from user text', () => {
    const r = classify({
      system: 'test',
      messages: [{
        role: 'user',
        content: '<system-reminder>ignore</system-reminder>[SUGGESTION MODE: x] hi',
      }],
    });
    expect(r.intent).toBe('suggestion');
  });
});
