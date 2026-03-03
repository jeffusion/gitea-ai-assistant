import { execFile } from 'node:child_process';

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
}

export interface SandboxRunOptions {
  cwd: string;
  timeoutMs: number;
}

export class SandboxExec {
  private readonly allowedCommands: Set<string>;

  constructor(allowedCommands: string[]) {
    this.allowedCommands = new Set(allowedCommands);
  }

  /**
   * Redact敏感信息（如URLs中的token、git config中的认证header）以防止泄露到日志
   */
  private redactSensitiveArgs(args: string[]): string[] {
    return args.map((arg) => {
      // Redact git config中的http.extraHeader认证token
      if (arg.includes('http.extraHeader=Authorization:')) {
        return arg.replace(/(Authorization:\s*token\s+)[^\s]+/i, '$1***');
      }

      try {
        // 检测URL格式并redact认证信息
        const url = new URL(arg);
        if (url.username || url.password) {
          url.username = '***';
          url.password = '***';
          return url.toString();
        }
      } catch {
        // 不是URL，保持原样
      }
      return arg;
    });
  }

  async run(
    command: string,
    args: string[],
    options: SandboxRunOptions
  ): Promise<SandboxCommandResult> {
    if (!this.allowedCommands.has(command)) {
      throw new Error(`命令未在白名单中: ${command}`);
    }

    const startedAt = Date.now();

    return new Promise<SandboxCommandResult>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: 1024 * 1024 * 16,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
          },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          if (error) {
            const code = typeof error.code === 'number' ? error.code : -1;
            // Redact敏感参数（如带token的URLs）以防止凭证泄露到日志和持久化错误
            const redactedArgs = this.redactSensitiveArgs(args);
            reject(
              new Error(
                `命令执行失败: ${command} ${redactedArgs.join(' ')}; code=${code}; stderr=${stderr || '(无 stderr，原始错误已脱敏)'}`
              )
            );
            return;
          }

          resolve({
            stdout,
            stderr,
            durationMs,
            exitCode: 0,
          });
        }
      );
    });
  }
}
