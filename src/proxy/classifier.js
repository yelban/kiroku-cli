export function classify(json) {
  if (!json) return { intent: 'unknown' };

  let sysText = '';
  if (json.system) {
    sysText = typeof json.system === 'string'
      ? json.system
      : Array.isArray(json.system)
        ? json.system.map(s => s.text || '').join('\n')
        : '';
  }

  const sysLower = sysText.toLowerCase();

  // Extract user text
  let userText = '';
  if (json.messages?.length > 0) {
    const lastUser = [...json.messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      userText = typeof lastUser.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser.content)
          ? lastUser.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : '';
    }
  }

  // Strip system reminders from user text for classification
  const strippedPrompt = userText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();

  // Classification (logging only, never used for interception)
  if (/a concise title|generate a title/i.test(sysLower)) {
    return { intent: 'title_generation', isMainline: false };
  }
  if (strippedPrompt.startsWith('[SUGGESTION MODE:')) {
    return { intent: 'suggestion', isMainline: false };
  }
  if (/tool search/i.test(sysLower)) {
    return { intent: 'tool_search', isMainline: false };
  }
  if (sysLower.includes('cc_entrypoint=cli')) {
    return { intent: 'mainline', isMainline: true };
  }

  return { intent: 'other', isMainline: false };
}
