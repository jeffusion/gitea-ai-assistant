import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WEBHOOK_SECRET = 'e2e-test-webhook-secret';
const TERMINAL_STATES = new Set(['completed', 'failed', 'ignored', 'cancelled', 'error']);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface GiteaUser {
  login: string;
  full_name?: string;
}

interface GiteaRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  ssh_url?: string;
  owner: GiteaUser;
}

interface GiteaPullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  head: {
    ref: string;
    sha: string;
    repo?: GiteaRepo;
  };
  base: {
    ref: string;
    sha: string;
    repo?: GiteaRepo;
  };
  requested_reviewers?: GiteaUser[];
  user?: GiteaUser;
}

interface Scenario {
  name: string;
  description: string;
  expectedTriageMode: string;
  expectedDomains: string[];
  minFindings: number;
  maxFindings?: number;
  minHighSeverity: number;
  testIdempotency?: boolean;
}

interface AdminLoginResponse {
  token: string;
}

interface SessionSummary {
  sessionId: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  status: string;
  findingCount: number;
}

interface SessionListEntry {
  session: {
    id: string;
    metadata?: Record<string, JsonValue>;
  };
  summary: SessionSummary;
}

interface SessionListResponse {
  data: SessionListEntry[];
}

interface Finding {
  severity?: string;
  confidence?: number;
  path?: string;
  line?: number;
  title?: string;
  detail?: string;
  evidence?: string;
  category?: string;
  domain?: string;
  fingerprint?: string;
}

interface SessionDetail {
  session: {
    id: string;
    metadata?: Record<string, JsonValue>;
  };
  summary: SessionSummary;
  checkpoint: {
    stopReason?: string;
    pendingTasks?: Array<{ name: string }>;
    state?: {
      targetSha?: string;
      triage?: {
        mode?: string;
        domains?: string[];
      };
      triageMode?: string;
      findings?: Finding[];
      published?: boolean;
      reviewedRefSaved?: boolean;
      reviewCompleted?: boolean;
      reviewedRef?: string;
      reviewDiagnostics?: {
        toolCallNames?: string[];
        toolCallCount?: number;
        parsedFindingCount?: number;
        stopReason?: string;
      };
    };
  } | null;
  plan: Array<{ key: string; status: string; label: string }>;
  events: Array<{ eventType: string; payload: Record<string, JsonValue> }>;
  runDetails: {
    findings?: Finding[];
    comments?: Array<{
      status?: string;
      path?: string;
      line?: number;
      body?: string;
      fingerprint?: string;
    }>;
  } | null;
  subagentInvocations: Array<{
    subagentName: string;
    status: string;
    result?: Record<string, JsonValue>;
  }>;
}

interface GiteaTokenResponse {
  sha1?: string;
  token?: string;
}

interface CommentLike {
  id: number;
  body: string;
  path?: string;
  line?: number;
}

interface SeedResult {
  owner: string;
  repo: string;
  prNumber: number;
  scenario: Scenario;
}

interface ReviewWaitResult {
  completed: boolean;
  sessionState: string;
  sessionId: string;
  detail: SessionDetail;
  observedStates: string[];
}

interface TriggerWebhookOptions {
  repositoryPatch?: Partial<GiteaRepo>;
  action?: string;
}

export class E2ETestHarness {
  readonly giteaUrl = (process.env.E2E_GITEA_URL ?? 'http://localhost:3333').replace(/\/$/, '');
  readonly adminUser = process.env.E2E_GITEA_ADMIN_USER ?? 'e2e-admin';
  readonly adminPass = process.env.E2E_GITEA_ADMIN_PASS ?? 'e2ePassword123!';

  private assistantProcess?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private assistantPort = 43100 + Math.floor(Math.random() * 1000);
  private tempDir = mkdtempSync(path.join(tmpdir(), 'e2e-assistant-'));
  private databasePath = path.join(this.tempDir, 'assistant.db');
  private reviewWorkDir = path.join(this.tempDir, 'review-workdir');
  private adminJwt?: string;
  private giteaToken?: string;
  private repoCounter = 0;

  get assistantUrl(): string {
    return `http://127.0.0.1:${this.assistantPort}`;
  }

  async start(): Promise<void> {
    await this.startAssistant();
    this.adminJwt = await this.getAdminJWT();
  }

  async stop(): Promise<void> {
    this.stopAssistant();
  }

  async startAssistant(): Promise<void> {
    if (this.assistantProcess) return;

    this.assistantProcess = Bun.spawn(['bun', 'run', 'src/index.ts'], {
      cwd: path.resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        E2E_MOCK_LLM: '1',
        ENCRYPTION_KEY,
        DATABASE_PATH: this.databasePath,
        REVIEW_ENGINE: 'kernel',
        PORT: String(this.assistantPort),
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
      },
    });

    this.drainProcessOutput(this.assistantProcess.stdout, 'assistant stdout');
    this.drainProcessOutput(this.assistantProcess.stderr, 'assistant stderr');
    await this.waitForAssistantHealth();
  }

  stopAssistant(): void {
    if (this.assistantProcess) {
      this.assistantProcess.kill();
      this.assistantProcess = undefined;
    }

    if (existsSync(this.tempDir)) {
      rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  async seedGitea(): Promise<void> {
    await this.waitForGitea();
    await this.ensureAdminUser();
    this.giteaToken = await this.createToken();
    await this.configureAssistant();
  }

  async seedPR(scenarioName: string): Promise<SeedResult> {
    if (!this.giteaToken) {
      await this.seedGitea();
    }

    const scenario = await this.readScenario(scenarioName);
    const owner = this.adminUser;
    const repo = `e2e-${scenarioName.replace(/[^a-z0-9-]/gi, '-')}-${Date.now()}-${this.repoCounter++}`;
    const baseBranch = 'main';
    const featureBranch = `feature/${scenarioName}-${this.repoCounter}`;

    await this.createRepo(repo);
    await this.pushBranchWithFiles(
      owner,
      repo,
      baseBranch,
      await this.readFixtureFiles(scenarioName, 'base'),
      `test: seed ${scenario.name} base`
    );
    await this.pushBranchWithFiles(
      owner,
      repo,
      featureBranch,
      await this.readFixtureFiles(scenarioName, 'branch'),
      `feat: ${scenario.description}`
    );
    const pr = await this.createPullRequest(
      owner,
      repo,
      scenario.description,
      featureBranch,
      baseBranch
    );
    await this.createWebhook(owner, repo);

    return { owner, repo, prNumber: pr.number, scenario };
  }

  async triggerWebhook(
    owner: string,
    repo: string,
    prNumber: number,
    options: TriggerWebhookOptions = {}
  ): Promise<{ status: string; runId?: string }> {
    const repository = await this.giteaFetch<GiteaRepo>(`/repos/${owner}/${repo}`);
    const pullRequest = await this.giteaFetch<GiteaPullRequest>(
      `/repos/${owner}/${repo}/pulls/${prNumber}`
    );
    const normalizedRepository = this.normalizeRepoUrls({
      ...repository,
      ...options.repositoryPatch,
      owner: repository.owner,
    });
    const payload = {
      action: options.action ?? 'opened',
      number: prNumber,
      pull_request: {
        ...pullRequest,
        head: {
          ...pullRequest.head,
          repo: pullRequest.head.repo ? this.normalizeRepoUrls(pullRequest.head.repo) : undefined,
        },
        base: {
          ...pullRequest.base,
          repo: pullRequest.base.repo ? this.normalizeRepoUrls(pullRequest.base.repo) : undefined,
        },
        requested_reviewers: pullRequest.requested_reviewers ?? [],
      },
      repository: normalizedRepository,
      sender: repository.owner,
    };
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    return this.fetchJson<{ status: string; runId?: string }>(
      `${this.assistantUrl}/webhook/gitea`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gitea-Event': 'pull_request',
          'X-Gitea-Signature': signature,
        },
        body,
      }
    );
  }

  async waitForReview(
    owner: string,
    repo: string,
    prNumber: number,
    timeoutSeconds = 120
  ): Promise<ReviewWaitResult> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const observedStates: string[] = [];

    while (Date.now() < deadline) {
      const entry = await this.findSession(owner, repo, prNumber);
      if (entry) {
        const status = entry.summary.status;
        if (observedStates.at(-1) !== status) observedStates.push(status);
        const detail = await this.getSessionDetail(entry.summary.sessionId);
        const detailStatus = detail.summary.status;
        if (observedStates.at(-1) !== detailStatus) observedStates.push(detailStatus);

        if (TERMINAL_STATES.has(detailStatus)) {
          return {
            completed: detailStatus === 'completed',
            sessionState: detailStatus,
            sessionId: entry.summary.sessionId,
            detail,
            observedStates,
          };
        }
      }

      await this.sleep(2000);
    }

    throw new Error(
      `Timed out waiting for review ${owner}/${repo}#${prNumber}; observed states: ${observedStates.join(' -> ') || 'none'}`
    );
  }

  async waitForSessionSnapshot(
    owner: string,
    repo: string,
    prNumber: number,
    timeoutSeconds = 30
  ): Promise<{ entry: SessionListEntry; detail: SessionDetail }> {
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const entry = await this.findSession(owner, repo, prNumber);
      if (entry) {
        return { entry, detail: await this.getSessionDetail(entry.summary.sessionId) };
      }
      await this.sleep(500);
    }

    throw new Error(`Timed out waiting for session snapshot ${owner}/${repo}#${prNumber}`);
  }

  async getAdminJWT(): Promise<string> {
    const response = await this.fetchJson<AdminLoginResponse>(
      `${this.assistantUrl}/admin/api/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password' }),
      }
    );
    return response.token;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    return this.adminFetch<SessionDetail>(
      `/admin/api/review/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  async getGiteaComments(owner: string, repo: string, prNumber: number): Promise<CommentLike[]> {
    const issueComments = await this.giteaFetch<CommentLike[]>(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`
    );

    const reviews = await this.giteaFetch<{ id: number }[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`
    );
    const reviewCommentLists = await Promise.all(
      reviews.map((r) =>
        this.giteaFetch<CommentLike[]>(
          `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${r.id}/comments`
        ).catch(() => [] as CommentLike[])
      )
    );
    const reviewComments = reviewCommentLists.flat();

    return [...issueComments, ...reviewComments];
  }

  extractFindings(detail: SessionDetail): Finding[] {
    return detail.checkpoint?.state?.findings ?? detail.runDetails?.findings ?? [];
  }

  extractTriageMode(detail: SessionDetail): string | undefined {
    return detail.checkpoint?.state?.triage?.mode ?? detail.checkpoint?.state?.triageMode;
  }

  extractDomains(detail: SessionDetail): string[] {
    const triageDomains = detail.checkpoint?.state?.triage?.domains;
    return triageDomains ?? [];
  }

  private async configureAssistant(): Promise<void> {
    await this.putConfig({
      GITEA_API_URL: `${this.giteaUrl}/api/v1`,
      GITEA_ACCESS_TOKEN: this.requireToken(),
      GITEA_ADMIN_TOKEN: this.requireToken(),
      WEBHOOK_SECRET,
      REVIEW_ENGINE: 'kernel',
      REVIEW_WORKDIR: this.reviewWorkDir,
      REVIEW_COMMAND_TIMEOUT_MS: '30000',
      REVIEW_ALLOWED_COMMANDS: 'git,rg,cat,sed,wc',
    });
  }

  private async putConfig(values: Record<string, string>): Promise<void> {
    const token = this.adminJwt ?? (await this.getAdminJWT());
    const response = await fetch(`${this.assistantUrl}/admin/api/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(values),
    });

    if (!response.ok) {
      throw new Error(`Failed to configure assistant: ${response.status} ${await response.text()}`);
    }
  }

  private async findSession(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<SessionListEntry | undefined> {
    const payload = await this.adminFetch<SessionListResponse>(
      '/admin/api/review/sessions?limit=100'
    );
    return payload.data.find((entry) => {
      const metadata = entry.session.metadata ?? {};
      const metadataOwner = typeof metadata.owner === 'string' ? metadata.owner : undefined;
      const metadataRepo = typeof metadata.repo === 'string' ? metadata.repo : undefined;
      const metadataPr =
        typeof metadata.prNumber === 'number' ? metadata.prNumber : Number(metadata.prNumber);
      return (
        (entry.summary.owner ?? metadataOwner) === owner &&
        (entry.summary.repo ?? metadataRepo) === repo &&
        (entry.summary.prNumber ?? metadataPr) === prNumber
      );
    });
  }

  private async adminFetch<T>(apiPath: string): Promise<T> {
    const token = this.adminJwt ?? (await this.getAdminJWT());
    return this.fetchJson<T>(`${this.assistantUrl}${apiPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async waitForAssistantHealth(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.assistantUrl}/api/health`);
        if (response.ok) return;
      } catch {
        await this.sleep(2000);
      }
    }
    throw new Error(`Assistant did not become healthy at ${this.assistantUrl}`);
  }

  private async waitForGitea(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.giteaUrl}/api/v1/version`);
        if (response.ok) return;
      } catch {
        await this.sleep(2000);
      }
      await this.sleep(2000);
    }
    throw new Error(`Gitea did not become available at ${this.giteaUrl}`);
  }

  private async ensureAdminUser(): Promise<void> {
    const loginCheck = await fetch(`${this.giteaUrl}/api/v1/user`, {
      headers: { Authorization: `Basic ${btoa(`${this.adminUser}:${this.adminPass}`)}` },
    });
    if (loginCheck.ok) return;

    const body = JSON.stringify({
      username: this.adminUser,
      password: this.adminPass,
      email: `${this.adminUser}@e2e-test.local`,
      must_change_password: false,
      login_name: this.adminUser,
      admin_permission: true,
    });

    for (const [user, pass] of [
      [this.adminUser, this.adminPass],
      ['root', 'root'],
    ] as const) {
      const response = await fetch(`${this.giteaUrl}/api/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
        },
        body,
      });

      if (response.ok || response.status === 422 || response.status === 409) return;
    }

    const retryLogin = await fetch(`${this.giteaUrl}/api/v1/user`, {
      headers: { Authorization: `Basic ${btoa(`${this.adminUser}:${this.adminPass}`)}` },
    });
    if (!retryLogin.ok) {
      throw new Error(
        `Unable to create or authenticate Gitea admin user: ${retryLogin.status} ${await retryLogin.text()}`
      );
    }
  }

  private async createToken(): Promise<string> {
    const response = await fetch(
      `${this.giteaUrl}/api/v1/users/${encodeURIComponent(this.adminUser)}/tokens`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`${this.adminUser}:${this.adminPass}`)}`,
        },
        body: JSON.stringify({ name: `e2e-token-${Date.now()}`, scopes: ['all'] }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to create Gitea token: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as GiteaTokenResponse;
    const token = payload.sha1 ?? payload.token;
    if (!token) throw new Error('Gitea token response did not include sha1/token');
    return token;
  }

  private async createRepo(name: string): Promise<GiteaRepo> {
    return this.giteaFetch<GiteaRepo>('/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, auto_init: true, default_branch: 'main' }),
    });
  }

  private async createPullRequest(
    owner: string,
    repo: string,
    description: string,
    head: string,
    base: string
  ): Promise<GiteaPullRequest> {
    return this.giteaFetch<GiteaPullRequest>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: `E2E: ${description}`,
        body: `E2E test PR: ${description}`,
        head,
        base,
      }),
    });
  }

  private async createWebhook(owner: string, repo: string): Promise<void> {
    await this.giteaFetch<JsonValue>(`/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'gitea',
        active: true,
        events: ['pull_request'],
        config: {
          url: `${this.assistantUrl}/webhook/gitea`,
          content_type: 'json',
          secret: WEBHOOK_SECRET,
        },
      }),
    });
  }

  private async giteaFetch<T>(apiPath: string, init: RequestInit = {}): Promise<T> {
    return this.fetchJson<T>(`${this.giteaUrl}/api/v1${apiPath}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${this.requireToken()}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async readScenario(scenarioName: string): Promise<Scenario> {
    const scenarioPath = path.join(this.fixturesDir(), scenarioName, 'scenario.json');
    return JSON.parse(await readFile(scenarioPath, 'utf-8')) as Scenario;
  }

  private async readFixtureFiles(
    scenarioName: string,
    fixturePart: 'base' | 'branch'
  ): Promise<Record<string, string>> {
    const dir = path.join(this.fixturesDir(), scenarioName, fixturePart);
    const files: Record<string, string> = {};
    const glob = new Bun.Glob('**/*');

    for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
      files[file] = await readFile(path.join(dir, file), 'utf-8');
    }

    return files;
  }

  private async pushBranchWithFiles(
    owner: string,
    repo: string,
    branchName: string,
    files: Record<string, string>,
    commitMessage: string
  ): Promise<void> {
    const tmpDir = mkdtempSync(
      path.join(tmpdir(), `e2e-push-${branchName.replace(/[^a-z0-9-]/gi, '-')}-`)
    );
    const cloneUrl = `${this.giteaUrl.replace('http://', `http://${this.adminUser}:${this.adminPass}@`)}/${owner}/${repo}.git`;

    try {
      await this.exec(['git', 'clone', cloneUrl, tmpDir]);
      await this.exec(['git', 'checkout', '-B', branchName], tmpDir);

      for (const [filePath, content] of Object.entries(files)) {
        const destination = path.join(tmpDir, filePath);
        mkdirSync(path.dirname(destination), { recursive: true });
        await Bun.write(destination, content);
      }

      await this.exec(['git', 'config', 'user.email', 'e2e@test.local'], tmpDir);
      await this.exec(['git', 'config', 'user.name', 'E2E Bot'], tmpDir);
      await this.exec(['git', 'add', '-A'], tmpDir);
      await this.exec(['git', 'commit', '-m', commitMessage, '--allow-empty'], tmpDir);
      await this.exec(['git', 'push', 'origin', branchName, '--force'], tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async exec(args: string[], cwd?: string): Promise<void> {
    const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Command failed (${args.join(' ')}):\n${stdout}\n${stderr}`);
    }
  }

  private fixturesDir(): string {
    return path.resolve(import.meta.dir, '../fixtures');
  }

  private normalizeRepoUrls(repo: GiteaRepo): GiteaRepo {
    return {
      ...repo,
      clone_url: this.normalizeGiteaUrl(repo.clone_url),
      html_url: this.normalizeGiteaUrl(repo.html_url),
      ssh_url: repo.ssh_url ? this.normalizeGiteaUrl(repo.ssh_url) : repo.ssh_url,
    };
  }

  private normalizeGiteaUrl(value: string): string {
    return value.replace('http://gitea:3000', this.giteaUrl);
  }

  private requireToken(): string {
    if (!this.giteaToken) throw new Error('Gitea token is not initialized');
    return this.giteaToken;
  }

  private drainProcessOutput(stream: ReadableStream<Uint8Array>, label: string): void {
    void new Response(stream).text().then((output) => {
      if (output.trim().length > 0 && process.env.E2E_DEBUG === '1') {
        console.log(`[${label}] ${output}`);
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export type { Finding, ReviewWaitResult, Scenario, SeedResult, SessionDetail };
