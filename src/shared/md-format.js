/**
 * Shared markdown formatting utilities for conversation logs and transcripts.
 */

export function formatToolUseBlock(name, input, maxLen = 50000) {
  let json;
  try {
    json = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  if (json.length > maxLen) {
    json = json.slice(0, maxLen) + `\n[truncated: ${json.length} chars]`;
  }
  return `#### Tool Use: \`${name}\`\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

export function formatToolResultBlock(content, maxLen = 50000) {
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[image]';
        return `[${c.type}]`;
      })
      .join('\n');
  } else {
    try { text = JSON.stringify(content, null, 2); } catch { text = String(content); }
  }
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n[truncated: ${text.length} chars]`;
  }
  return `**Tool Result:**\n\n${text}\n`;
}

export function formatThinkingBlock(text) {
  if (!text) return '';
  return `<details><summary>Thinking</summary>\n\n${text}\n\n</details>\n`;
}
