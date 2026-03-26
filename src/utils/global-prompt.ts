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

export function mergeReviewPrompts(
  globalPrompt: string | undefined,
  projectPrompt: string | undefined
): string | undefined {
  const normalized = [globalPrompt, projectPrompt]
    .map((item) => item?.trim())
    .filter((item): item is string => !!item && item.length > 0);

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join('\n\n');
}

export function withCoreGlobalPrompt(
  systemContent: string,
  globalPrompt: string | undefined,
  maxChars?: number
): string {
  if (!globalPrompt || globalPrompt.trim() === '') {
    return systemContent;
  }

  const normalized = globalPrompt.trim();
  const compact =
    typeof maxChars === 'number' && maxChars > 0 ? normalized.slice(0, maxChars) : normalized;
  return `${systemContent}\n\n${compact}`;
}
