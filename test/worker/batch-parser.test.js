import { describe, it, expect } from 'vitest';
import { createBatchStreamParser } from '../../src/worker/batch-parser.js';

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n`;
}

function textDelta(text) {
  return sseLine({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
}

describe('createBatchStreamParser', () => {
  it('parses two complete turns terminated by ===TURN_N_END===', () => {
    const parser = createBatchStreamParser();
    parser.feed(textDelta('{"turn_index":0,"entities":[],"facts":[]}\n'));
    parser.feed(textDelta('===TURN_0_END===\n'));
    parser.feed(textDelta('{"turn_index":1,"entities":[],"facts":[]}\n===TURN_1_END===\n'));
    parser.feed(textDelta('===BATCH_END===\n'));
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(2);
    expect(out.completedTurns[0].turn_index).toBe(0);
    expect(out.completedTurns[1].turn_index).toBe(1);
    expect(out.errors).toHaveLength(0);
  });

  it('handles text deltas split across SSE events mid-JSON', () => {
    const parser = createBatchStreamParser();
    const chunks = [
      '{"turn_index":0,',
      '"entities":[{"canonical_name":"user",',
      '"entity_type":"person","aliases":[]}],',
      '"facts":[]}\n===TURN_0_END===\n',
    ];
    for (const c of chunks) parser.feed(textDelta(c));
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(1);
    expect(out.completedTurns[0].entities[0].canonical_name).toBe('user');
  });

  it('keeps already-completed turns when later turns are truncated', () => {
    const parser = createBatchStreamParser();
    parser.feed(textDelta('{"turn_index":0,"entities":[],"facts":[]}\n===TURN_0_END===\n'));
    parser.feed(textDelta('{"turn_index":1,"entities":['));
    parser.feed(sseLine({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }));
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(1);
    expect(out.stopReason).toBe('max_tokens');
    expect(out.truncatedTail).toContain('"turn_index":1');
  });

  it('records a json_parse_error for malformed turn payload but keeps emitting later turns', () => {
    const parser = createBatchStreamParser();
    parser.feed(textDelta('{"turn_index":0,bogus}\n===TURN_0_END===\n'));
    parser.feed(textDelta('{"turn_index":1,"entities":[],"facts":[]}\n===TURN_1_END===\n'));
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(1);
    expect(out.completedTurns[0].turn_index).toBe(1);
    expect(out.errors[0].kind).toBe('json_parse_error');
    expect(out.errors[0].turn_index).toBe(0);
  });

  it('flags turn_index mismatch when JSON index does not match delimiter N', () => {
    const parser = createBatchStreamParser();
    parser.feed(textDelta('{"turn_index":7,"entities":[],"facts":[]}\n===TURN_2_END===\n'));
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(1);
    expect(out.errors.find(e => e.kind === 'turn_index_mismatch')).toBeTruthy();
  });

  it('captures usage from message_start and message_delta', () => {
    const parser = createBatchStreamParser();
    parser.feed(sseLine({ type: 'message_start', message: { usage: { input_tokens: 1234 } } }));
    parser.feed(textDelta('{"turn_index":0,"entities":[],"facts":[]}\n===TURN_0_END===\n'));
    parser.feed(sseLine({ type: 'message_delta', usage: { output_tokens: 567 } }));
    const out = parser.finalize();
    expect(out.usage.input_tokens).toBe(1234);
    expect(out.usage.output_tokens).toBe(567);
  });

  it('feedRaw bypasses SSE framing for direct text injection', () => {
    const parser = createBatchStreamParser();
    parser.feedRaw('{"turn_index":0,"entities":[],"facts":[]}\n===TURN_0_END===\n');
    const out = parser.finalize();
    expect(out.completedTurns).toHaveLength(1);
  });
});
