import { describe, test, expect } from 'bun:test';
import { SandboxExec } from '../context/sandbox-exec';

describe('SandboxExec', () => {
  // ─── Command whitelist ───
  describe('command whitelist', () => {
    test('allowed command executes successfully', async () => {
      const sandbox = new SandboxExec(['echo']);
      const result = await sandbox.run('echo', ['hello'], {
        cwd: '/tmp',
        timeoutMs: 5000,
      });
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
    });

    test('disallowed command throws', async () => {
      const sandbox = new SandboxExec(['echo']);
      await expect(
        sandbox.run('rm', ['-rf', '/'], { cwd: '/tmp', timeoutMs: 5000 })
      ).rejects.toThrow('命令未在白名单中: rm');
    });

    test('empty whitelist blocks all commands', async () => {
      const sandbox = new SandboxExec([]);
      await expect(
        sandbox.run('echo', ['hello'], { cwd: '/tmp', timeoutMs: 5000 })
      ).rejects.toThrow('命令未在白名单中: echo');
    });

    test('multiple commands in whitelist', async () => {
      const sandbox = new SandboxExec(['echo', 'ls', 'cat']);
      const result = await sandbox.run('echo', ['test'], {
        cwd: '/tmp',
        timeoutMs: 5000,
      });
      expect(result.stdout.trim()).toBe('test');
    });
  });

  // ─── Error redaction (the token leak fix) ───
  describe('error redaction', () => {
    test('failed command error does NOT contain original error.message', async () => {
      const sandbox = new SandboxExec(['ls']);
      try {
        // ls a path that doesn't exist → stderr-based error
        await sandbox.run('ls', ['/nonexistent-path-that-does-not-exist-12345'], {
          cwd: '/tmp',
          timeoutMs: 5000,
        });
        // If it doesn't throw, the path happened to exist, skip
      } catch (error: any) {
        // The error message should use stderr content or the redacted fallback
        // It should NOT include raw Node.js error.message which may contain tokens
        expect(error.message).toContain('命令执行失败');
        expect(error.message).toContain('ls');
      }
    });

    test('error with no stderr uses redacted fallback message', async () => {
      const sandbox = new SandboxExec(['false']);
      try {
        // `false` exits with code 1, no stderr output
        await sandbox.run('false', [], {
          cwd: '/tmp',
          timeoutMs: 5000,
        });
      } catch (error: any) {
        expect(error.message).toContain('命令执行失败');
        // Should use the redacted fallback, not error.message
        expect(error.message).toContain('(无 stderr，原始错误已脱敏)');
      }
    });
  });

  // ─── Sensitive argument redaction ───
  describe('sensitive arg redaction in error messages', () => {
    test('URL with credentials is redacted in error', async () => {
      const sandbox = new SandboxExec(['git']);
      try {
        await sandbox.run(
          'git',
          ['clone', 'https://user:secret-token@example.com/repo.git', '/nonexistent'],
          { cwd: '/tmp', timeoutMs: 5000 }
        );
      } catch (error: any) {
        // The error message should have redacted credentials
        expect(error.message).not.toContain('secret-token');
        expect(error.message).toContain('***');
      }
    });

    test('http.extraHeader Authorization token is redacted in error', async () => {
      const sandbox = new SandboxExec(['git']);
      try {
        await sandbox.run(
          'git',
          [
            '-c',
            'http.extraHeader=Authorization: token ghp_secrettoken123',
            'clone',
            'https://example.com/repo.git',
            '/nonexistent',
          ],
          { cwd: '/tmp', timeoutMs: 5000 }
        );
      } catch (error: any) {
        expect(error.message).not.toContain('ghp_secrettoken123');
        expect(error.message).toContain('***');
      }
    });

    test('non-sensitive args are preserved in error', async () => {
      const sandbox = new SandboxExec(['ls']);
      try {
        await sandbox.run('ls', ['--color', '/nonexistent-12345'], {
          cwd: '/tmp',
          timeoutMs: 5000,
        });
      } catch (error: any) {
        expect(error.message).toContain('--color');
        expect(error.message).toContain('/nonexistent-12345');
      }
    });
  });

  // ─── Duration tracking ───
  test('result includes durationMs', async () => {
    const sandbox = new SandboxExec(['echo']);
    const result = await sandbox.run('echo', ['hi'], {
      cwd: '/tmp',
      timeoutMs: 5000,
    });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Stderr capture ───
  test('stderr is captured on success', async () => {
    const sandbox = new SandboxExec(['ls']);
    const result = await sandbox.run('ls', ['/tmp'], {
      cwd: '/tmp',
      timeoutMs: 5000,
    });
    // stderr should be a string (possibly empty)
    expect(typeof result.stderr).toBe('string');
  });

  // ─── Environment isolation ───
  test('only PATH, HOME, LANG, LC_ALL are passed to child process', async () => {
    // Set a custom env var that should NOT be visible
    process.env.SUPER_SECRET_TOKEN = 'should-not-leak';
    const sandbox = new SandboxExec(['env']);
    const result = await sandbox.run('env', [], {
      cwd: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.stdout).not.toContain('SUPER_SECRET_TOKEN');
    expect(result.stdout).not.toContain('should-not-leak');
    delete process.env.SUPER_SECRET_TOKEN;
  });
});
