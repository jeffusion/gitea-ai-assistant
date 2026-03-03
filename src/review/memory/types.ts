export interface MemoryEntry {
  id: string;
  type: 'finding' | 'feedback' | 'pattern';
  content: string;
  embedding?: number[];
  metadata: {
    category?: string;
    severity?: string;
    approved?: boolean;
    timestamp: string;
    project?: string;
    owner?: string;
    repo?: string;
  };
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  distance: number;
}

export interface FeedbackRecord {
  findingId: string;
  approved: boolean;
  reason: string;
  timestamp: string;
  reviewer?: string;
}
