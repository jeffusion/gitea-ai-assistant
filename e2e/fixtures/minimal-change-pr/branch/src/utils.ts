export function normalizeScore(score: number): number {
  if (score <= 0) {
    return 0;
  }

  if (score >= 100) {
    return 100;
  }

  return Math.floor(score);
}

export function formatUserName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}
