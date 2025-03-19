import OpenAI from 'openai';
import config from '../config';
import { logger } from '../utils/logger';
import { giteaService, PullRequestFile } from './gitea';

// 创建OpenAI客户端
const openai = new OpenAI({
  baseURL: config.openai.baseUrl,
  apiKey: config.openai.apiKey,
});

// 代码审查结果接口
export interface CodeReviewResult {
  summary: string;
  lineComments: LineComment[];
}

// 行评论接口
export interface LineComment {
  path: string;
  line: number;
  comment: string;
}

// 审查上下文
interface ReviewContext {
  changedFiles: PullRequestFile[];
  fileContents: Record<string, string>;
  diffContent: string;
}

// AI代码审查服务
export const aiReviewService = {
  /**
   * 对代码差异进行审查
   * @param owner 仓库所有者
   * @param repo 仓库名称
   * @param prNumber PR编号
   * @param diffContent 代码差异内容
   * @param commitSha 提交SHA
   * @returns 代码审查结果
   */
  async reviewCode(
    owner: string,
    repo: string,
    prNumber: number,
    diffContent: string,
    commitSha: string
  ): Promise<CodeReviewResult> {
    try {
      logger.info('开始PR代码审查', { owner, repo, prNumber });

      // 获取完整的审查上下文
      const context = await this.getReviewContext(owner, repo, prNumber, diffContent, commitSha);

      // 使用上下文进行总体评价
      const summary = await this.generateSummary(context);

      // 使用上下文生成行级评论
      const lineComments = await this.generateLineComments(context);

      return {
        summary,
        lineComments,
      };
    } catch (error: any) {
      logger.error('AI代码审查失败:', error);
      throw new Error(`AI代码审查失败: ${error.message}`);
    }
  },

  /**
   * 对单个提交进行代码审查
   * @param owner 仓库所有者
   * @param repo 仓库名称
   * @param commitSha 提交SHA
   * @param customFiles 可选的自定义文件列表
   * @returns 代码审查结果
   */
  async reviewCommit(
    owner: string,
    repo: string,
    commitSha: string,
    customFiles?: PullRequestFile[]
  ): Promise<CodeReviewResult> {
    try {
      logger.info('开始提交代码审查', { owner, repo, commitSha });

      // 获取提交差异
      const diffContent = await giteaService.getCommitDiff(owner, repo, commitSha);
      if (!diffContent) {
        logger.warn('提交差异为空，无法进行代码审查');
        return {
          summary: '提交差异为空，无法进行代码审查',
          lineComments: []
        };
      }

      // 获取或使用提供的文件列表
      let files: PullRequestFile[] = [];
      if (customFiles && customFiles.length > 0) {
        files = customFiles;
        logger.info(`使用自定义文件列表，包含 ${files.length} 个文件`);
      } else {
        files = await giteaService.getCommitFiles(owner, repo, commitSha);
        logger.info(`从API获取到 ${files.length} 个变更文件`);
      }

      // 获取文件内容
      const fileContents = await giteaService.getRelatedFiles(owner, repo, files, commitSha);

      const context: ReviewContext = {
        changedFiles: files,
        fileContents,
        diffContent
      };

      // 使用上下文进行总体评价
      const summary = await this.generateSummary(context);

      // 使用上下文生成行级评论
      const lineComments = await this.generateLineComments(context);

      return {
        summary,
        lineComments,
      };
    } catch (error: any) {
      logger.error('AI提交代码审查失败:', error);
      throw new Error(`AI提交代码审查失败: ${error.message}`);
    }
  },

  /**
   * 获取完整的审查上下文
   */
  async getReviewContext(
    owner: string,
    repo: string,
    prNumber: number,
    diffContent: string,
    commitSha: string
  ): Promise<ReviewContext> {
    try {
      // 获取PR变更的文件列表
      const changedFiles = await giteaService.getPullRequestFiles(owner, repo, prNumber);
      logger.info(`获取到 ${changedFiles.length} 个变更文件`);

      // 获取所有变更文件的完整内容
      const fileContents = await giteaService.getRelatedFiles(owner, repo, changedFiles, commitSha);
      logger.info(`获取到 ${Object.keys(fileContents).length} 个文件的完整内容`);

      return {
        changedFiles,
        fileContents,
        diffContent
      };
    } catch (error: any) {
      logger.error('获取审查上下文失败:', error);
      // 如果获取上下文失败，至少返回diff内容
      return {
        changedFiles: [],
        fileContents: {},
        diffContent
      };
    }
  },

  /**
   * 生成总体评价
   * @param context 审查上下文
   * @returns 总体评价
   */
  async generateSummary(context: ReviewContext): Promise<string> {
    try {
      // 准备上下文信息
      const fileInfo = context.changedFiles.map(file => {
        return {
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          content: context.fileContents[file.filename] || '无法获取文件内容'
        };
      });

      // 使用自定义prompt或默认prompt
      const defaultSummaryPrompt = `作为经验丰富的代码审查专家，请对以下代码变更进行深入审查，提供一个全面详细的评价和建议。
      关注点包括但不限于：代码质量、潜在bug、性能问题、安全问题、最佳实践等。
      请用中文回复，保持专业简洁。

      ==== diff变更内容 ====
      ${context.diffContent}

      ==== 变更文件的完整信息 ====
      ${JSON.stringify(fileInfo, null, 2)}

      请根据以上信息，特别是考虑每个文件的完整内容和上下文，提供代码审查评价。如果没有发现明显问题，请简短说明代码质量良好即可。`;

      const summaryPrompt = config.openai.customSummaryPrompt || defaultSummaryPrompt;

      // 获取总体评价
      const summaryResponse = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的代码审查助手，擅长识别代码中的严重问题和bug。你会查看代码的完整上下文，而不是为了评论而评论。如无明显问题，应给予简短肯定。'
          },
          { role: 'user', content: summaryPrompt }
        ],
        temperature: 0.1,
      });

      const summary = summaryResponse.choices[0]?.message.content || '无法生成代码审查摘要';
      return summary;
    } catch (error: any) {
      logger.error('生成总体评价失败:', error);
      return '由于技术原因，无法生成详细的代码审查评价。';
    }
  },

  /**
   * 生成行级评论
   * @param context 审查上下文
   * @returns 行级评论数组
   */
  async generateLineComments(context: ReviewContext): Promise<LineComment[]> {
    try {
      // 解析差异内容，提取文件和变更行
      const diffFiles = this.parseDiff(context.diffContent);
      const lineComments: LineComment[] = [];

      // 对每个文件的变更行进行审查
      for (const file of diffFiles) {
        // 只对添加的行进行评论
        const addedLines = file.changes.filter(change => change.type === 'add');
        if (addedLines.length === 0) continue;

        // 获取文件的完整内容作为上下文
        const fileContent = context.fileContents[file.path] || '';

        // 使用自定义prompt或默认prompt
        const defaultFilePrompt = `分析以下代码文件的新增代码行，只针对存在明显bug或严重问题的代码行提供具体评论。
        大多数代码行不需要评论，除非它们包含以下问题：
        - 明显的bug或逻辑错误
        - 严重的安全漏洞
        - 可能导致崩溃的代码
        - 明显的性能瓶颈
        - 数据一致性问题

        如果没有发现严重问题，请返回空数组。不要为了提供评论而勉强寻找问题。

        文件路径: ${file.path}

        完整文件内容:
        ${fileContent}

        变更部分上下文:
        ${file.changes.map(c => `${c.lineNumber}: ${c.content} (${c.type === 'add' ? '新增' : '上下文'})`).join('\n')}

        请以JSON格式返回评论，格式如下:
        [
          {
            "line": 行号,
            "comment": "评论内容"
          }
        ]
        只返回JSON数组，不要有其他文本。`;

        const filePrompt = config.openai.customLineCommentPrompt || defaultFilePrompt;

        // 获取行级评论
        const lineResponse = await openai.chat.completions.create({
          model: config.openai.model,
          messages: [
            {
              role: 'system',
              content: '你是一个谨慎的代码审查助手，只对有明显bug或严重问题的代码行提供评论。大多数情况下，如果代码没有严重问题，你应该返回空数组。请以JSON格式返回结果。'
            },
            { role: 'user', content: filePrompt }
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        const content = lineResponse.choices[0]?.message.content;
        if (!content) continue;

        try {
          // 解析JSON响应
          const responseObject = JSON.parse(content);
          const comments = Array.isArray(responseObject) ? responseObject : (responseObject.comments || []);

          // 添加到结果中
          for (const comment of comments) {
            if (comment.line && comment.comment) {
              lineComments.push({
                path: file.path,
                line: comment.line,
                comment: comment.comment
              });
            }
          }
        } catch (parseError: any) {
          logger.error(`解析行评论JSON失败: ${parseError.message}`, content);
        }
      }

      return lineComments;
    } catch (error: any) {
      logger.error('生成行级评论失败:', error);
      return [];
    }
  },

  /**
   * 解析git diff内容
   * @param diffContent diff内容
   * @returns 解析后的文件变更信息
   */
  parseDiff(diffContent: string): Array<{
    path: string;
    changes: Array<{ lineNumber: number; content: string; type: 'add' | 'context' }>
  }> {
    const files: Array<{
      path: string;
      changes: Array<{ lineNumber: number; content: string; type: 'add' | 'context' }>
    }> = [];

    const diffLines = diffContent.split('\n');
    let currentFile: {
      path: string;
      changes: Array<{ lineNumber: number; content: string; type: 'add' | 'context' }>
    } | null = null;

    let lineNumber = 0;
    let inHunk = false;

    for (const line of diffLines) {
      // 新文件开始
      if (line.startsWith('diff --git')) {
        if (currentFile) {
          files.push(currentFile);
        }
        currentFile = { path: '', changes: [] };
        inHunk = false;
      }
      // 获取文件路径
      else if (line.startsWith('+++ b/')) {
        if (currentFile) {
          currentFile.path = line.substring(6);
        }
      }
      // Hunk头，记录起始行号
      else if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match && match[1]) {
          lineNumber = parseInt(match[1], 10) - 1; // 因为下面会+1
          inHunk = true;
        }
      }
      // 解析变更行
      else if (inHunk && currentFile) {
        if (line.startsWith('+')) {
          // 添加的行
          lineNumber++;
          currentFile.changes.push({
            lineNumber,
            content: line.substring(1),
            type: 'add'
          });
        } else if (line.startsWith(' ')) {
          // 上下文行
          lineNumber++;
          currentFile.changes.push({
            lineNumber,
            content: line.substring(1),
            type: 'context'
          });
        } else if (line.startsWith('-')) {
          // 删除的行，不增加行号
          // 我们不对删除的行做评论，所以这里不处理
        } else {
          // 其他行，比如"No newline at end of file"
          // 不增加行号，不做特殊处理
        }
      }
    }

    // 添加最后一个文件
    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }
};
