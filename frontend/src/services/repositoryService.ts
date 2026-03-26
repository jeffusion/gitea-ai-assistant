import api from '@/lib/api';

export interface Repository {
  name: string;
  webhook_status: 'active' | 'inactive';
  hook_id: number | null;
  project_review_prompt: string | null;
}

export interface PaginatedRepositories {
  data: Repository[];
  totalCount: number;
  page: number;
  limit: number;
}

export const fetchRepositories = async (page: number = 1, query: string = ""): Promise<PaginatedRepositories> => {
  const { data } = await api.get('/repositories', {
    params: { page, q: query },
  });
  return data;
};

export const updateRepositoryProjectPrompt = async (
  repoName: string,
  projectReviewPrompt: string
): Promise<{ success: boolean; project_review_prompt: string | null }> => {
  const { data } = await api.put(`/repositories/${repoName}/project-prompt`, {
    project_review_prompt: projectReviewPrompt,
  });
  return data;
};
