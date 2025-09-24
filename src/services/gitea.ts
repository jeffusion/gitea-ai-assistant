import axios from 'axios';
import config from '../config';
import { logger } from '../utils/logger';
import { LineComment } from './ai-review';

// 打印将要使用的 Admin Token，用于调试
logger.info(`Gitea Admin Token used: [${config.admin.giteaAdminToken}]`);
logger.info(`Gitea Access Token (fallback): [${config.gitea.accessToken}]`);

// 创建API客户端
const giteaClient = axios.create({
  baseURL: config.gitea.apiUrl,
  headers: {
    'Authorization': `token ${config.gitea.accessToken}`,
    'Content-Type': 'application/json',
  },
});

// 创建用于管理操作的API客户端
const giteaAdminClient = axios.create({
  baseURL: config.gitea.apiUrl,
  headers: {
    'Authorization': `token ${config.admin.giteaAdminToken || config.gitea.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'curl/7.81.0', // 伪装成 curl
  },
  proxy: false, // 禁用所有代理
});

// Gitea服务接口定义
export interface GiteaService {
  // 获取PR的文件差异
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;

  // 获取PR详情
  getPullRequestDetails(owner: string, repo: string, prNumber: number): Promise<PullRequestDetails>;

  // 获取PR变更的文件列表
  getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>;

  // 获取单个提交的差异
  getCommitDiff(owner: string, repo: string, commitSha: string): Promise<string>;

  // 获取单个提交的文件列表
  getCommitFiles(owner: string, repo: string, commitSha: string): Promise<PullRequestFile[]>;

  // 获取与提交关联的Pull Request
  getRelatedPullRequest(owner: string, repo: string, commitSha: string): Promise<PullRequestDetails | null>;

  // 获取文件内容
  getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string>;

  // 获取引用的相关文件
  getRelatedFiles(owner: string, repo: string, files: PullRequestFile[], commitSha: string): Promise<Record<string, string>>;

  // 添加PR评论
  addPullRequestComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;

  // 添加代码行评论
  addLineComments(
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    comments: LineComment[]
  ): Promise<void>;

  // 添加提交评论
  addCommitComment(owner: string, repo: string, commitSha: string, body: string): Promise<void>;

  // 管理后台方法
  listAllRepositories(page: number, limit: number, query?: string): Promise<{ repos: any[], totalCount: number }>;
  listWebhooks(owner: string, repo: string): Promise<any[]>;
  createWebhook(owner: string, repo: string, webhookUrl: string): Promise<void>;
  deleteWebhook(owner: string, repo: string, hookId: number): Promise<void>;
}

// PR详情接口
export interface PullRequestDetails {
  id: number;
  number: number;
  title: string;
  head: {
    sha: string;
  };
  base: {
    repo: {
      owner: {
        login: string;
      };
      name: string;
    };
  };
}

// PR文件接口
export interface PullRequestFile {
  filename: string;
  status: string; // 'added', 'modified', 'removed'
  additions: number;
  deletions: number;
  changes: number;
  raw_url?: string;
}

// Gitea服务实现
export const giteaService: GiteaService = {
  // 获取PR的差异
  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    try {
      const response = await giteaClient.get(`/repos/${owner}/${repo}/pulls/${prNumber}.diff`);
      return response.data;
    } catch (error: any) {
      logger.error('获取PR差异失败:', error);
      throw new Error(`获取PR差异失败: ${error.message}`);
    }
  },

  // 获取PR详情
  async getPullRequestDetails(owner: string, repo: string, prNumber: number): Promise<PullRequestDetails> {
    try {
      const response = await giteaClient.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      return response.data;
    } catch (error: any) {
      logger.error('获取PR详情失败:', error);
      throw new Error(`获取PR详情失败: ${error.message}`);
    }
  },

  // 获取PR变更的文件列表
  async getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]> {
    try {
      const response = await giteaClient.get(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
      return response.data || [];
    } catch (error: any) {
      logger.error('获取PR文件列表失败:', error);
      throw new Error(`获取PR文件列表失败: ${error.message}`);
    }
  },

  // 获取单个提交的差异
  async getCommitDiff(owner: string, repo: string, commitSha: string): Promise<string> {
    try {
      const response = await giteaClient.get(`/repos/${owner}/${repo}/git/commits/${commitSha}`);

      // Gitea API 不直接提供提交的差异，可能需要另外请求
      // 这里使用"比较"API获取差异
      const parentSha = response.data.parents[0]?.sha;
      if (!parentSha) {
        logger.warn(`提交 ${commitSha} 没有父提交，无法获取差异`);
        return '';
      }

      // 使用官方API获取差异，使用diff格式
      const diffResponse = await giteaClient.get(`/repos/${owner}/${repo}/git/commits/${commitSha}.diff`);
      return diffResponse.data || '';
    } catch (error: any) {
      logger.error('获取提交差异失败:', error);
      throw new Error(`获取提交差异失败: ${error.message}`);
    }
  },

  // 获取单个提交的文件列表
  async getCommitFiles(owner: string, repo: string, commitSha: string): Promise<PullRequestFile[]> {
    try {
      // Gitea API没有直接获取单个提交文件列表的端点
      // 我们尝试获取提交信息，提取文件列表
      const response = await giteaClient.get(`/repos/${owner}/${repo}/git/commits/${commitSha}`);

      // 从webhook的数据提取文件列表
      // 注意: 这不是理想的方式，但是对于status webhook中提供的文件列表是合理的

      // 这里只能返回基本信息，因为Gitea API不提供单个提交的详细文件信息
      if (response.data.files) {
        // 如果API返回了文件列表，则使用它
        return response.data.files;
      } else {
        // 否则返回空数组，依赖控制器中webhook提供的文件列表
        return [];
      }
    } catch (error: any) {
      logger.error('获取提交文件列表失败:', error);
      throw new Error(`获取提交文件列表失败: ${error.message}`);
    }
  },

  // 获取与提交关联的Pull Request
  async getRelatedPullRequest(owner: string, repo: string, commitSha: string): Promise<PullRequestDetails | null> {
    try {
      // 获取仓库中所有开放的PR
      const response = await giteaClient.get(`/repos/${owner}/${repo}/pulls?state=open`);
      const pullRequests = response.data || [];

      // 遍历每个PR，检查它是否包含目标提交
      for (const pr of pullRequests) {
        try {
          const prDetails = await giteaService.getPullRequestDetails(owner, repo, pr.number);

          // 检查PR的提交列表
          const commitsResponse = await giteaClient.get(`/repos/${owner}/${repo}/pulls/${pr.number}/commits`);
          const commits = commitsResponse.data || [];

          // 检查提交是否在PR中
          const foundCommit = commits.find((commit: any) => commit.sha === commitSha);
          if (foundCommit) {
            return prDetails;
          }
        } catch (error) {
          logger.warn(`检查PR #${pr.number}是否包含提交 ${commitSha} 时出错`, error);
        }
      }

      // 没有找到包含该提交的PR
      return null;
    } catch (error: any) {
      logger.error('获取相关PR失败:', error);
      return null;
    }
  },

  // 获取文件内容
  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string> {
    try {
      const url = `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
      const response = await giteaClient.get(url);

      // Gitea API可能返回base64编码的内容
      if (response.data.content) {
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }

      return '';
    } catch (error: any) {
      logger.error(`获取文件内容失败: ${path}`, error);
      // 文件不存在时不抛出错误，而是返回空字符串
      return '';
    }
  },

  // 获取引用的相关文件
  async getRelatedFiles(owner: string, repo: string, files: PullRequestFile[], commitSha: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    // 对每个修改过的文件，获取其完整内容
    for (const file of files) {
      // 排除删除的文件
      if (file.status !== 'removed') {
        try {
          const content = await giteaService.getFileContent(owner, repo, file.filename, commitSha);
          if (content) {
            result[file.filename] = content;
          }
        } catch (error) {
          logger.warn(`无法获取文件内容: ${file.filename}`, error);
        }
      }
    }

    return result;
  },

  // 添加PR评论
  async addPullRequestComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    try {
      await giteaClient.post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body });
    } catch (error: any) {
      logger.error('添加PR评论失败:', error);
      throw new Error(`添加PR评论失败: ${error.message}`);
    }
  },

  // 添加代码行评论
  async addLineComments(
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    comments: LineComment[]
  ): Promise<void> {
    try {
      // 如果没有评论，直接返回
      if (comments.length === 0) {
        return;
      }

      // 使用 PR Review API 批量添加评论
      await giteaClient.post(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        event: 'COMMENT',
        commit_id: commitId,
        comments: comments.map(comment => ({
          path: comment.path,
          body: comment.comment,
          new_position: comment.line,
        })),
      });

      logger.info(`成功添加 ${comments.length} 条代码行评论`);
    } catch (error: any) {
      logger.error('添加代码行评论失败:', error);

      // 如果批量添加失败，尝试逐条添加
      logger.info('尝试逐条添加评论...');
      try {
        for (const comment of comments) {
          await giteaClient.post(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
            body: comment.comment,
            commit_id: commitId,
            path: comment.path,
            line: comment.line,
            position: comment.line,  // Gitea使用position参数表示行号
          });
        }
        logger.info(`成功逐条添加 ${comments.length} 条评论`);
      } catch (fallbackError: any) {
        logger.error('逐条添加评论失败:', fallbackError);
        throw new Error(`添加代码行评论失败: ${error.message}`);
      }
    }
  },

  // 添加提交评论
  async addCommitComment(owner: string, repo: string, commitSha: string, body: string): Promise<void> {
    try {
      await giteaClient.post(`/repos/${owner}/${repo}/git/commits/${commitSha}/comments`, { body });
    } catch (error: any) {
      logger.error('添加提交评论失败:', error);
      throw new Error(`添加提交评论失败: ${error.message}`);
    }
  },

  // 获取所有仓库
  async listAllRepositories(page: number = 1, limit: number = 30, query?: string): Promise<{ repos: any[], totalCount: number }> {
    try {
      const response = await giteaAdminClient.get('/repos/search', {
        params: {
          page,
          limit,
          q: query,
        },
      });
      const totalCount = parseInt(response.headers['x-total-count'] || '0', 10);
      return { repos: response.data.data, totalCount };
    } catch (error: any) {
      logger.error('获取所有仓库列表失败:', error);
      throw new Error(`获取所有仓库列表失败: ${error.message}`);
    }
  },

  // 列出仓库的webhooks
  async listWebhooks(owner: string, repo: string): Promise<any[]> {
    try {
      const response = await giteaAdminClient.get(`/repos/${owner}/${repo}/hooks`);
      return response.data;
    } catch (error: any) {
      logger.error(`获取 ${owner}/${repo} 的 webhook 列表失败:`, error);
      throw new Error(`获取 webhook 列表失败: ${error.message}`);
    }
  },

  // 创建webhook
  async createWebhook(owner: string, repo: string, webhookUrl: string): Promise<void> {
    try {
      await giteaAdminClient.post(`/repos/${owner}/${repo}/hooks`, {
        type: 'gitea',
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: config.app.webhookSecret,
        },
        events: ['pull_request', 'status'],
        active: true,
      });
    } catch (error: any) {
      logger.error(`为 ${owner}/${repo} 创建 webhook 失败:`, error);
      throw new Error(`创建 webhook 失败: ${error.message}`);
    }
  },

  // 删除webhook
  async deleteWebhook(owner: string, repo: string, hookId: number): Promise<void> {
    try {
      await giteaAdminClient.delete(`/repos/${owner}/${repo}/hooks/${hookId}`);
    } catch (error: any) {
      logger.error(`删除 ${owner}/${repo} 的 webhook #${hookId} 失败:`, error);
      throw new Error(`删除 webhook 失败: ${error.message}`);
    }
  },
};
