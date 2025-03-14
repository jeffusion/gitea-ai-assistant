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
      logger.info('开始代码审查', { owner, repo, prNumber });

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

      // 构建更丰富的提示
      const summaryPrompt = `作为经验丰富的代码审查专家，请对以下代码变更进行深入审查，提供一个全面详细的评价和建议。
      关注点包括但不限于：代码质量、潜在bug、性能问题、安全问题、最佳实践等。
      请用中文回复，保持专业简洁。

      ==== diff变更内容 ====
      ${context.diffContent}

      ==== 变更文件的完整信息 ====
      ${JSON.stringify(fileInfo, null, 2)}

      请根据以上信息，特别是考虑每个文件的完整内容和上下文，提供详细的代码审查评价。`;

      // 获取总体评价
      const summaryResponse = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的代码审查助手，擅长提供有建设性的代码评审意见。你会查看代码的完整上下文，而不仅仅是变更部分，从而提供更准确的评价。'
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

        // 构建提示
        const filePrompt = `分析以下代码文件的新增代码行，找出潜在问题并提供具体行级评论。
        只对有问题的代码行提供评论，如果代码行没有明显问题则不需要评论。
        为每个评论提供行号和具体的改进建议。

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

        // 获取行级评论
        const lineResponse = await openai.chat.completions.create({
          model: config.openai.model,
          messages: [
            {
              role: 'system',
              content: '你是一个精确的代码审查助手，只对有问题的代码行提供具体评论。你会考虑文件的完整上下文，而不仅仅是变更部分。请以JSON格式返回结果。'
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
