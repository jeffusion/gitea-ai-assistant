/**
 * Parses the diff content and extracts the line numbers of added or modified lines.
 *
 * @param diffContent The git diff string.
 * @returns A record where keys are filenames and values contain the added line numbers.
 */
export function parseDiffHunks(diffContent: string): Record<string, { addedLines: number[] }> {
  const files: Record<string, { addedLines: number[] }> = {};
  const lines = diffContent.split('\n');

  let currentFile: string | null = null;
  let currentLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.substring(6);
      if (!files[currentFile]) {
        files[currentFile] = { addedLines: [] };
      }
      continue;
    }

    if (line.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        currentLineNumber = parseInt(match, 10);
      }
      continue;
    }

    if (currentFile) {
      if (line.startsWith('+')) {
        files[currentFile].addedLines.push(currentLineNumber);
        currentLineNumber++;
      } else if (!line.startsWith('-')) {
        currentLineNumber++;
      }
    }
  }

  // Deduplicate lines just in case
  for (const file in files) {
    files[file].addedLines = [...new Set(files[file].addedLines)];
  }

  return files;
}
