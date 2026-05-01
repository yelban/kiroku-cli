const IDENTIFIER_RE = /[@\w]{4,}|[\w-]+\.(com|org|net|io)|\/[\w/-]+/;
const TRIVIAL_STRIP_RE = /[。！，、 \s]/g;

export function shouldSkipTurn(event, filterConfig) {
  if (!filterConfig || !filterConfig.enabled) return null;

  const userText = (event.request?.user_text || '').trim();
  const assistantText = (event.response?.assistant_text || '').trim();
  const toolResults = event.request?.tool_results || [];

  if (filterConfig.skipPureToolTurns
      && toolResults.length > 0
      && userText.length === 0
      && assistantText.length === 0) {
    return 'pure_tool_turn';
  }

  const trivialPhrases = filterConfig.trivialAssistantPhrases || [];
  if (trivialPhrases.length > 0 && assistantText.length > 0 && userText.length < 30) {
    const assistantStripped = assistantText.replace(TRIVIAL_STRIP_RE, '');
    const hit = trivialPhrases.some(p => assistantStripped === p.replace(TRIVIAL_STRIP_RE, ''));
    if (hit) return 'trivial_assistant_response';
  }

  const combinedLen = userText.length + assistantText.length;
  if (combinedLen < (filterConfig.minTextLength ?? 50)) {
    const combined = `${userText} ${assistantText}`;
    if (!IDENTIFIER_RE.test(combined)) {
      return 'too_short_no_identifier';
    }
  }

  return null;
}
