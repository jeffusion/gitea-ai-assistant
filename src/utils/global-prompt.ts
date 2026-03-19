/**
 * Helper to inject the global prompt into LLM system messages.
 *
 * If globalPrompt is non-empty, it is appended to the original system content
 * separated by a blank line.  Otherwise the original content is returned as-is.
 */
export function withGlobalPrompt(systemContent: string, globalPrompt: string | undefined): string {
  if (!globalPrompt || globalPrompt.trim() === '') {
    return systemContent;
  }
  return `${systemContent}\n\n${globalPrompt}`;
}

export function withCoreGlobalPrompt(
  systemContent: string,
  globalPrompt: string | undefined,
  maxChars = 240
): string {
  if (!globalPrompt || globalPrompt.trim() === '') {
    return systemContent;
  }
  const compact = globalPrompt.trim().slice(0, maxChars);
  return `${systemContent}\n\n${compact}`;
}
