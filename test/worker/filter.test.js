import { describe, it, expect } from 'vitest';
import { shouldSkipTurn } from '../../src/worker/filter.js';

const baseConfig = {
  enabled: true,
  minTextLength: 50,
  skipPureToolTurns: true,
  trivialAssistantPhrases: ['OK', '好的', '了解', '收到', '已完成', 'Done', '完成', '可以'],
};

function makeEvent({ user_text = '', assistant_text = '', tool_results = [] } = {}) {
  return {
    request: { user_text, tool_results },
    response: { assistant_text },
  };
}

describe('shouldSkipTurn', () => {
  it('returns null when filter disabled', () => {
    const event = makeEvent({ user_text: 'hi' });
    expect(shouldSkipTurn(event, { ...baseConfig, enabled: false })).toBeNull();
  });

  it('returns null when filterConfig is missing', () => {
    expect(shouldSkipTurn(makeEvent({ user_text: 'hi' }), undefined)).toBeNull();
  });

  it('skips pure tool_results turn (no user_text, no assistant_text)', () => {
    const event = makeEvent({ tool_results: [{ id: 't1', output: '...' }] });
    expect(shouldSkipTurn(event, baseConfig)).toBe('pure_tool_turn');
  });

  it('does not flag pure_tool_turn when skipPureToolTurns disabled (still falls through to too-short)', () => {
    const event = makeEvent({ tool_results: [{ id: 't1' }] });
    expect(shouldSkipTurn(event, { ...baseConfig, skipPureToolTurns: false })).toBe('too_short_no_identifier');
  });

  it('skips short turn without identifier', () => {
    const event = makeEvent({ user_text: 'hi', assistant_text: 'sup' });
    expect(shouldSkipTurn(event, baseConfig)).toBe('too_short_no_identifier');
  });

  it('keeps short turn that contains an email-like identifier', () => {
    const event = makeEvent({ user_text: 'mail me at a@b.com' });
    expect(shouldSkipTurn(event, baseConfig)).toBeNull();
  });

  it('keeps short turn with a path-like identifier', () => {
    const event = makeEvent({ user_text: 'edit /etc/hosts' });
    expect(shouldSkipTurn(event, baseConfig)).toBeNull();
  });

  it('keeps short turn with a domain-like identifier', () => {
    const event = makeEvent({ user_text: 'check kiroku.io' });
    expect(shouldSkipTurn(event, baseConfig)).toBeNull();
  });

  it('skips when assistant says only "好的" with short user prompt', () => {
    const event = makeEvent({ user_text: '繼續', assistant_text: '好的' });
    expect(shouldSkipTurn(event, baseConfig)).toBe('trivial_assistant_response');
  });

  it('skips when assistant says only "OK"', () => {
    const event = makeEvent({ user_text: 'go', assistant_text: 'OK' });
    expect(shouldSkipTurn(event, baseConfig)).toBe('trivial_assistant_response');
  });

  it('does not flag trivial response when user_text is long', () => {
    const longUser = 'A'.repeat(40);
    const event = makeEvent({ user_text: longUser, assistant_text: 'OK' });
    expect(shouldSkipTurn(event, baseConfig)).toBeNull();
  });

  it('keeps long substantive turn', () => {
    const event = makeEvent({
      user_text: '我們決定使用 PostgreSQL 15 作為主資料庫，因為需要 jsonb 與 RLS。',
      assistant_text: '了解，我會更新 schema 並加上 RLS 政策。',
    });
    expect(shouldSkipTurn(event, baseConfig)).toBeNull();
  });

  it('treats empty event safely', () => {
    expect(shouldSkipTurn({}, baseConfig)).toBe('too_short_no_identifier');
  });
});
