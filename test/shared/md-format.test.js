import { describe, it, expect } from 'vitest';
import { formatToolUseBlock, formatToolResultBlock, formatThinkingBlock } from '../../src/shared/md-format.js';

describe('formatToolUseBlock', () => {
  it('should format tool use with name and JSON input', () => {
    const result = formatToolUseBlock('Read', { file: 'test.js' });
    expect(result).toContain('#### Tool Use: `Read`');
    expect(result).toContain('"file": "test.js"');
    expect(result).toContain('```json');
  });

  it('should handle string input', () => {
    const result = formatToolUseBlock('Bash', 'ls -la');
    expect(result).toContain('`Bash`');
    expect(result).toContain('ls -la');
  });

  it('should truncate long input', () => {
    const long = 'x'.repeat(200);
    const result = formatToolUseBlock('Read', long, 100);
    expect(result).toContain('[truncated: 200 chars]');
  });

  it('should handle non-serializable input', () => {
    const circular = {};
    circular.self = circular;
    const result = formatToolUseBlock('Test', circular);
    expect(result).toContain('[object Object]');
  });
});

describe('formatToolResultBlock', () => {
  it('should format string content', () => {
    const result = formatToolResultBlock('file contents here');
    expect(result).toContain('**Tool Result:**');
    expect(result).toContain('file contents here');
  });

  it('should format array content with text blocks', () => {
    const content = [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ];
    const result = formatToolResultBlock(content);
    expect(result).toContain('line 1');
    expect(result).toContain('line 2');
  });

  it('should handle image blocks', () => {
    const content = [{ type: 'image' }];
    const result = formatToolResultBlock(content);
    expect(result).toContain('[image]');
  });

  it('should handle unknown block types', () => {
    const content = [{ type: 'audio' }];
    const result = formatToolResultBlock(content);
    expect(result).toContain('[audio]');
  });

  it('should truncate long content', () => {
    const long = 'y'.repeat(200);
    const result = formatToolResultBlock(long, 100);
    expect(result).toContain('[truncated: 200 chars]');
  });

  it('should handle object content (JSON)', () => {
    const result = formatToolResultBlock({ key: 'val' });
    expect(result).toContain('"key": "val"');
  });
});

describe('formatThinkingBlock', () => {
  it('should wrap in details tag', () => {
    const result = formatThinkingBlock('deep thought');
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>Thinking</summary>');
    expect(result).toContain('deep thought');
    expect(result).toContain('</details>');
  });

  it('should return empty string for falsy input', () => {
    expect(formatThinkingBlock('')).toBe('');
    expect(formatThinkingBlock(null)).toBe('');
    expect(formatThinkingBlock(undefined)).toBe('');
  });
});
