import api from '@/lib/api';

export interface Repository {
  name: string;
  webhook_status: 'active' | 'inactive';
  hook_id: number | null;
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
