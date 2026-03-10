export function createSseRecorder(opts = {}) {
  const storeThinking = opts.storeThinking || false;
  let assistantText = '';
  let thinkingText = '';
  const toolUses = [];
  let currentToolName = null;
  let currentToolInput = '';
  let usage = {};
  let stopReason = null;
  let messageComplete = false;

  // We'll accumulate raw text and parse it
  const decoder = new TextDecoder();
  let buffer = '';

  function feed(chunk) {
    // Accumulate chunks as text
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;

    // Parse complete SSE events from buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          processEvent(parsed);
        } catch {
          // ignore parse errors
        }
      }
    }
  }

  function processEvent(data) {
    switch (data.type) {
      case 'message_start':
        if (data.message?.usage) {
          usage = { ...usage, ...data.message.usage };
        }
        break;

      case 'content_block_start':
        if (data.content_block?.type === 'tool_use') {
          currentToolName = data.content_block.name;
          currentToolInput = '';
        }
        break;

      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          assistantText += data.delta.text;
        } else if (data.delta?.type === 'input_json_delta') {
          currentToolInput += data.delta.partial_json;
        } else if (data.delta?.type === 'thinking_delta' && storeThinking) {
          thinkingText += data.delta.thinking;
        }
        break;

      case 'content_block_stop':
        if (currentToolName) {
          let input = {};
          try { input = JSON.parse(currentToolInput); } catch {}
          toolUses.push({ name: currentToolName, input });
          currentToolName = null;
          currentToolInput = '';
        }
        break;

      case 'message_delta':
        if (data.delta?.stop_reason) {
          stopReason = data.delta.stop_reason;
        }
        if (data.usage) {
          usage = { ...usage, ...data.usage };
        }
        break;

      case 'message_stop':
        messageComplete = true;
        break;
    }
  }

  function finalize() {
    // Process any remaining data in buffer
    if (buffer.trim()) {
      if (buffer.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(buffer.slice(6).trim());
          processEvent(parsed);
        } catch {}
      }
    }

    if (!messageComplete && !assistantText && toolUses.length === 0) {
      return null; // No useful data captured
    }

    return {
      assistantText,
      thinkingText: storeThinking ? thinkingText : undefined,
      toolUses,
      stopReason,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    };
  }

  return { feed, finalize };
}
