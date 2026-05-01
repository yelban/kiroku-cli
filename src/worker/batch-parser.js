const TURN_END_RE = /===TURN_(\d+)_END===\n?/;

export function createBatchStreamParser() {
  let sseBuffer = '';
  let textBuffer = '';
  const completedTurns = [];
  let stopReason = null;
  let usage = null;
  const decoder = new TextDecoder();
  const errors = [];

  function processSseEvent(data) {
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      textBuffer += data.delta.text;
      drainTextBuffer();
    } else if (data.type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) usage = { ...(usage || {}), ...data.usage };
    } else if (data.type === 'message_start') {
      if (data.message?.usage) usage = { ...(usage || {}), ...data.message.usage };
    }
  }

  function drainTextBuffer() {
    let match;
    while ((match = textBuffer.match(TURN_END_RE))) {
      const jsonPart = textBuffer.slice(0, match.index).trim();
      const declaredIndex = Number(match[1]);
      try {
        const parsed = JSON.parse(jsonPart);
        if (typeof parsed.turn_index !== 'number') parsed.turn_index = declaredIndex;
        if (parsed.turn_index !== declaredIndex) {
          errors.push({ kind: 'turn_index_mismatch', declared: declaredIndex, parsed: parsed.turn_index });
        }
        completedTurns.push({
          turn_index: parsed.turn_index,
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        });
      } catch (err) {
        errors.push({
          kind: 'json_parse_error',
          turn_index: declaredIndex,
          excerpt: jsonPart.slice(0, 200),
          message: err.message,
        });
      }
      textBuffer = textBuffer.slice(match.index + match[0].length);
    }
  }

  function feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    sseBuffer += text;

    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        processSseEvent(JSON.parse(data));
      } catch {
        // ignore SSE-level parse errors; partial JSON arrives across chunks
      }
    }
  }

  function feedRaw(text) {
    textBuffer += text;
    drainTextBuffer();
  }

  function finalize() {
    if (sseBuffer.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(sseBuffer.slice(6).trim());
        processSseEvent(parsed);
      } catch { /* ignore */ }
      sseBuffer = '';
    }
    return {
      completedTurns,
      stopReason,
      usage,
      errors,
      truncatedTail: textBuffer,
    };
  }

  return { feed, feedRaw, finalize };
}
