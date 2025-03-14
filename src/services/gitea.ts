import axios from 'axios';
import config from '../config';
import { logger } from '../utils/logger';
import { LineComment } from './ai-review';

// 创建API客户端
const giteaClient = axios.create({
  baseURL: config.gitea.apiUrl,
  headers: {
    'Authorization': `token ${config.gitea.accessToken}`,
    'Content-Type': 'application/json',
  },
});

// Gitea服务接口定义
export interface GiteaService {
  // 获取PR的文件差异
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;

  // 获取PR详情
  getPullRequestDetails(owner: string, repo: string, prNumber: number): Promise<PullRequestDetails>;

  // 获取PR变更的文件列表
  getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>;

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
};
