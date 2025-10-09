# MultiAgent代码审查系统技术实现文档

## 1. 核心接口定义

### 1.1 基础类型定义

```typescript
// Agent类型枚举
enum AgentType {
  // 编排与调度Agent
  ORCHESTRATOR = 'orchestrator',
  GLOBAL_CONTEXT_ANALYZER = 'global_context_analyzer',

  // 并行分析Agent (通用)
  DIFF_ANALYST = 'diff_analyst',
  SECURITY_SCANNER = 'security_scanner',
  QUALITY_CHECKER = 'quality_checker',
  COMPLEXITY_ANALYZER = 'complexity_analyzer',

  // 并行分析Agent (语言特定)
  LANGUAGE_SPECIALIST = 'language_specialist',

  // 整合与生成Agent
  REFINEMENT_SYNTHESIS = 'refinement_synthesis',
  FINAL_REPORT_GENERATOR = 'final_report_generator',
}

// Agent状态
interface AgentState {
  id: string;
  type: AgentType;
  status: 'idle' | 'working' | 'completed' | 'failed';
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  metadata: {
    confidence: number;
    processingTime: number;
    tokensUsed: number;
    errors?: string[];
    retries?: number;
    statusMessage?: string;
  };
}

// Agent执行结果
interface AgentResult {
  output: any;
  confidence: number;
  metadata: {
    processingTime: number;
    tokensUsed: number;
    rulesApplied?: string[];
    errors?: string[];
    timedOut?: boolean;
  };
}

// 全局状态管理
interface GlobalReviewState {
  prContext: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    diffContent: string;
  };

  fileAnalysis: {
    [filePath: string]: {
      rawContent: string;
      diffContent: string;
      fileType: string;
      language: string;
      analysisResults: Record<AgentType, any>;
    };
  };

  agentStates: Record<string, AgentState>;

  intermediateResults: {
    crossFileDependencies?: Record<string, string[]>; // 新增：跨文件依赖
    securityFindings: SecurityFinding[];
    qualityIssues: QualityIssue[];
    complexityMetrics: ComplexityMetric[];
    languageInsights: LanguageInsight[];
  };

  finalResult?: ComprehensiveReviewResult;
}
```

### 1.2 分析结果类型定义

```typescript
// 安全发现
interface SecurityFinding {
  type: 'security';
  severity: 'low' | 'medium' | 'high' | 'critical';
  rule: string;
  message: string;
  filePath: string;
  lines: number[];
  evidence: string[];
  recommendation: string;
  cweId?: string; // CWE漏洞编号
  confidence: number;
}

// 质量问题
interface QualityIssue {
  type: 'quality';
  severity: 'low' | 'medium' | 'high';
  category: 'maintainability' | 'readability' | 'performance' | 'style';
  message: string;
  filePath: string;
  line?: number;
  suggestion: string;
  confidence: number;
}

// 复杂度指标
interface ComplexityMetric {
  filePath: string;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  linesOfCode: number;
  maintainabilityIndex: number;
  technicalDebt: {
    estimatedMinutes: number;
    issues: string[];
  };
}

// 语言洞察
interface LanguageInsight {
  language: string;
  filePath: string;
  patterns: {
    idioms: string[];
    antiPatterns: string[];
    bestPractices: string[];
  };
  dependencies: {
    direct: string[];
    circular: string[];
    unused: string[];
  };
  typeIssues?: {
    errors: string[];
    warnings: string[];
  };
}

// 综合审查结果
interface ComprehensiveReviewResult {
  summary: string;
  overallScore: number; // 1-10
  riskLevel: 'low' | 'medium' | 'high';

  findings: {
    security: SecurityFinding[];
    quality: QualityIssue[];
    complexity: ComplexityMetric[];
    language: LanguageInsight[];
  };

  lineComments: LineComment[];

  recommendations: {
    critical: string[];
    high: string[];
    medium: string[];
    low: string[];
  };

  metadata: {
    totalFilesAnalyzed: number;
    totalAgentsUsed: number;
    averageConfidence: number;
    processingTime: number;
    uncertainAreas?: string[];
  };
}
```

## 2. 核心框架实现

### 2.1 Agent基类

```typescript
abstract class BaseAgent {
  abstract type: AgentType;
  abstract description: string;

  abstract async process(
    input: any,
    state: GlobalReviewState
  ): Promise<AgentResult>;

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: true };
  }
}
```

### 2.2 Agent框架核心

```typescript
class AgentFramework {
  private state: GlobalReviewState;
  private agents: Map<AgentType, BaseAgent>;
  private orchestrator: OrchestratorAgent;
  private config: MultiAgentConfig;

  constructor(config: MultiAgentConfig) {
    this.config = config;
    this.agents = new Map();
    this.setupAgents();
    this.orchestrator = this.agents.get(AgentType.ORCHESTRATOR) as OrchestratorAgent;
    if (!this.orchestrator) {
      throw new Error("OrchestratorAgent must be registered.");
    }
  }

  // 注册Agent
  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.type, agent);
    logger.info(`Registered agent: ${agent.type}`);
  }

  // 执行审查流程
  async executeReview(input: ReviewInput): Promise<ComprehensiveReviewResult> {
    const startTime = Date.now();

    try {
      // 1. 初始化状态
      this.state = await this.initializeState(input);

      // 2. 运行全局上下文分析
      const contextAnalyzer = this.agents.get(AgentType.GLOBAL_CONTEXT_ANALYZER);
      if (contextAnalyzer) {
        const contextResult = await contextAnalyzer.process(this.state.fileAnalysis, this.state);
        this.state.intermediateResults.crossFileDependencies = contextResult.output;
        logger.info('全局上下文分析完成');
      }

      // 3. 由Orchestrator驱动执行
      this.state = await this.orchestrator.run(this.state, this.agents);

      // 4. 验证结果
      if (!this.state.finalResult) {
        throw new Error('工作流执行完成但未生成最终结果');
      }

      // 5. 添加执行元数据
      this.state.finalResult.metadata.processingTime = Date.now() - startTime;

      return this.state.finalResult;

    } catch (error) {
      logger.error('Agent框架执行失败:', error);
      return this.createFailureResult(error as Error, Date.now() - startTime);
    }
  }

  // 初始化状态
  private async initializeState(input: ReviewInput): Promise<GlobalReviewState> {
    const state: GlobalReviewState = {
      prContext: {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        commitSha: input.commitSha,
        diffContent: input.diffContent
      },
      fileAnalysis: {},
      agentStates: {},
      intermediateResults: {
        securityFindings: [],
        qualityIssues: [],
        complexityMetrics: [],
        languageInsights: []
      }
    };

    // 获取变更文件信息
    const files = await giteaService.getPullRequestFiles(
      input.owner, input.repo, input.prNumber
    );

    // 初始化文件分析数据
    for (const file of files) {
      if (file.status !== 'removed') {
        const content = await giteaService.getFileContent(
          input.owner, input.repo, file.filename, input.commitSha
        );

        state.fileAnalysis[file.filename] = {
          rawContent: content || '',
          diffContent: this.extractFileDiff(input.diffContent, file.filename),
          fileType: this.detectFileType(file.filename),
          language: this.detectLanguage(file.filename),
          analysisResults: {}
        };
      }
    }

    return state;
  }

  // 创建失败结果
  private createFailureResult(error: Error, processingTime: number): ComprehensiveReviewResult {
    return {
      summary: `代码审查执行失败: ${error.message}`,
      overallScore: 0,
      riskLevel: 'high',
      findings: {
        security: [],
        quality: [],
        complexity: [],
        language: []
      },
      lineComments: [],
      recommendations: {
        critical: ['请检查系统配置和网络连接'],
        high: [],
        medium: [],
        low: []
      },
      metadata: {
        totalFilesAnalyzed: 0,
        totalAgentsUsed: 0,
        averageConfidence: 0,
        processingTime,
        uncertainAreas: ['系统执行失败，所有分析结果不可用']
      }
    };
  }

  // 工具方法
  private detectFileType(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase();
    const typeMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'go': 'go',
      'rs': 'rust',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'clj': 'clojure',
      'hs': 'haskell',
      'ml': 'ocaml',
      'fs': 'fsharp',
      'ex': 'elixir',
      'erl': 'erlang',
      'dart': 'dart',
      'lua': 'lua',
      'r': 'r',
      'jl': 'julia',
      'nim': 'nim',
      'zig': 'zig'
    };

    return typeMap[extension || ''] || 'unknown';
  }

  private detectLanguage(filename: string): string {
    // 基于文件扩展名检测编程语言
    return this.detectFileType(filename);
  }

  private extractFileDiff(fullDiff: string, filename: string): string {
    // 从完整diff中提取特定文件的diff内容
    const lines = fullDiff.split('\n');
    let inFile = false;
    let fileDiff: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        inFile = line.includes(filename);
        if (inFile) {
          fileDiff = [line];
        }
      } else if (line.startsWith('diff --git') && inFile) {
        break; // 开始下一个文件
      } else if (inFile) {
        fileDiff.push(line);
      }
    }

    return fileDiff.join('\n');
  }
}
```

### 2.3 工作流实现 (Orchestrator-Driven)

```typescript
class OrchestratorAgent extends BaseAgent {
  type = AgentType.ORCHESTRATOR;
  description = "流程编排与任务分发的核心";

  async process(
    input: any,
    state: GlobalReviewState
  ): Promise<AgentResult> {
    // The 'process' method is not directly used for orchestration.
    // The main logic is in the 'run' method.
    return { output: state, confidence: 1.0, metadata: { processingTime: 0, tokensUsed: 0 } };
  }

  async run(
    state: GlobalReviewState,
    agents: Map<AgentType, BaseAgent>
  ): Promise<GlobalReviewState> {
    // 1. 智能调度与并行分析
    // OrchestratorAgent现在将基于更复杂的逻辑来决定如何分析文件
    await this.runSmartParallelAnalysis(state, agents);

    // 2. 结果综合与精炼
    await this.runSynthesis(state, agents);

    // 3. 生成最终报告
    await this.runReportGeneration(state, agents);

    return state;
  }

  private async runSmartParallelAnalysis(
    state: GlobalReviewState,
    agents: Map<AgentType, BaseAgent>
  ) {
    const analysisPromises = Object.keys(state.fileAnalysis).map(async (filePath) => {
      const fileData = state.fileAnalysis[filePath];

      // 智能调度逻辑
      const applicableAgents = this.selectApplicableAgents(fileData, state, agents);

      // 并行执行所有适用的Agent
      const agentPromises = applicableAgents.map(agent => {
        return agent.process(fileData, state).then(result => ({
          agentType: agent.type,
          result
        })).catch(error => {
          // 即使单个Agent失败，也不中断整个流程
          logger.error(`Agent ${agent.type} failed on file ${filePath}:`, error);
          return { agentType: agent.type, result: null, error };
        });
      });

      const results = await Promise.all(agentPromises);

      // 更新文件分析结果
      for (const { agentType, result } of results) {
        if (result) {
          fileData.analysisResults[agentType] = result.output;
        }
      }
    });

    await Promise.all(analysisPromises);
  }

  private async runSynthesis(
    state: GlobalReviewState,
    agents: Map<AgentType, BaseAgent>
  ) {
    const synthesisAgent = agents.get(AgentType.REFINEMENT_SYNTHESIS);
    if (synthesisAgent) {
      const result = await synthesisAgent.process(state.fileAnalysis, state);
      state.intermediateResults = result.output;
    } else {
      throw new Error("Refinement & Synthesis Agent not found.");
    }
  }

  private async runReportGeneration(
    state: GlobalReviewState,
    agents: Map<AgentType, BaseAgent>
  ) {
    const reportAgent = agents.get(AgentType.FINAL_REPORT_GENERATOR);
    if (reportAgent) {
      const result = await reportAgent.process(state.intermediateResults, state);
      state.finalResult = result.output;
    } else {
      throw new Error("Final Report Generator Agent not found.");
    }
  }

  /**
   * 智能调度逻辑伪代码:
   *
   * 1. function selectApplicableAgents(fileData, globalState, allAgents):
   * 2.   let selectedAgents = []
   * 3.
   * 4.   // 决策因素
   * 5.   let fileType = fileData.fileType
   * 6.   let changeSize = fileData.diffContent.length
   * 7.   let isHighRisk = isFileHighRisk(fileData.filePath, globalState.crossFileDependencies)
   * 8.
   * 9.   // 规则 1: 基础分析 (始终运行)
   * 10.  selectedAgents.push(allAgents.get(DIFF_ANALYST))
   * 11.
   * 12.  // 规则 2: 微小变更
   * 13.  if changeSize < 20:
   * 14.    return selectedAgents // 仅执行Diff分析
   * 15.
   * 16.  // 规则 3: 安全扫描
   * 17.  if fileType is 'source_code' or isHighRisk:
   * 18.    selectedAgents.push(allAgents.get(SECURITY_SCANNER))
   * 19.
   * 20.  // 规则 4: 质量与复杂度
   * 21.  if changeSize > 100 or isHighRisk:
   * 22.    selectedAgents.push(allAgents.get(QUALITY_CHECKER))
   * 23.    selectedAgents.push(allAgents.get(COMPLEXITY_ANALYZER))
   * 24.
   * 25.  // 规则 5: 语言特定分析
   * 26.  if isLanguageSupported(fileData.language):
   * 27.    selectedAgents.push(allAgents.get(LANGUAGE_SPECIALIST))
   * 28.
   * 29.  // 规则 6: 用户自定义跳过
   * 30.  if fileData.rawContent.includes('@review:skip-security'):
   * 31.    selectedAgents = selectedAgents.filter(agent => agent.type !== SECURITY_SCANNER)
   * 32.
   * 33.  return unique(selectedAgents)
   */
  private selectApplicableAgents(
    fileData: any,
    state: GlobalReviewState,
    agents: Map<AgentType, BaseAgent>
  ): BaseAgent[] {
    const selectedAgents: Set<BaseAgent> = new Set();

    // 决策因素
    const changeSize = fileData.diffContent.length;
    const isSourceCode = !['json', 'markdown', 'yaml', 'xml'].includes(fileData.fileType);
    const crossFileDeps = state.intermediateResults.crossFileDependencies || {};
    const isHighRisk = Object.values(crossFileDeps).flat().includes(fileData.filePath);

    // 规则 1: 基础分析
    selectedAgents.add(agents.get(AgentType.DIFF_ANALYST)!);

    // 规则 2: 微小变更
    if (changeSize < 20 && !isHighRisk) {
      return Array.from(selectedAgents).filter(Boolean);
    }

    // 规则 3: 安全扫描
    if (isSourceCode || isHighRisk) {
      selectedAgents.add(agents.get(AgentType.SECURITY_SCANNER)!);
    }

    // 规则 4: 质量与复杂度
    if (changeSize > 100 || isHighRisk) {
      selectedAgents.add(agents.get(AgentType.QUALITY_CHECKER)!);
      selectedAgents.add(agents.get(AgentType.COMPLEXITY_ANALYZER)!);
    }

    // 规则 5: 语言特定分析
    if (this.isLanguageSupported(fileData.language)) {
      selectedAgents.add(agents.get(AgentType.LANGUAGE_SPECIALIST)!);
    }

    // 规则 6: 用户自定义跳过 (示例)
    if (fileData.rawContent.includes('@review:skip-security')) {
        selectedAgents.delete(agents.get(AgentType.SECURITY_SCANNER)!);
    }

    return Array.from(selectedAgents).filter(Boolean);
  }

  private isLanguageSupported(language: string): boolean {
    // 实际实现中会从配置中读取支持的语言列表
    const supportedLanguages = ['typescript', 'javascript', 'python', 'java', 'go'];
    return supportedLanguages.includes(language);
  }
}
```

## 3. 具体Agent实现

### 3.1 安全扫描Agent

```typescript
class SecurityScannerAgent extends BaseAgent {
  type = AgentType.SECURITY_SCANNER;
  readonly description = '安全漏洞扫描和风险评估专家';
  readonly supportedLanguages: string[] = []; // 支持所有语言

  private securityRules: SecurityRule[];

  constructor() {
    super();
    this.securityRules = this.loadSecurityRules();
  }

  async process(
    input: FileAnalysisInput,
    state: GlobalReviewState
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const findings: SecurityFinding[] = [];
    let tokensUsed = 0;

    try {
      // 1. 基于规则的静态扫描
      const staticFindings = await this.performStaticScan(input);
      findings.push(...staticFindings);

      // 2. 基于AI的深度分析 (对于复杂案例)
      if (this.shouldPerformAIAnalysis(input, staticFindings)) {
        const aiFindings = await this.performAIAnalysis(input);
        findings.push(...aiFindings.findings);
        tokensUsed += aiFindings.tokensUsed;
      }

      // 3. 计算置信度
      const confidence = this.calculateConfidence(findings, input);

      return {
        output: findings,
        confidence,
        metadata: {
          processingTime: Date.now() - startTime,
          tokensUsed,
          rulesApplied: this.securityRules.map(r => r.name)
        }
      };

    } catch (error) {
      return this.handleError(error as Error, 'security scanning');
    }
  }

  // 静态规则扫描
  private async performStaticScan(input: FileAnalysisInput): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];

    for (const rule of this.securityRules) {
      // 检查规则是否适用于当前文件
      if (!this.isRuleApplicable(rule, input.fileType, input.language)) {
        continue;
      }

      const matches = this.findMatches(rule, input.content);
      for (const match of matches) {
        findings.push({
          type: 'security',
          severity: rule.severity,
          rule: rule.name,
          message: rule.message,
          filePath: input.filePath,
          lines: match.lines,
          evidence: match.evidence,
          recommendation: rule.recommendation,
          cweId: rule.cweId,
          confidence: rule.confidence || 0.8
        });
      }
    }

    return findings;
  }

  // AI深度分析
  private async performAIAnalysis(input: FileAnalysisInput): Promise<{ findings: SecurityFinding[]; tokensUsed: number }> {
    const prompt = this.buildSecurityAnalysisPrompt(input);

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: '你是一位资深的安全专家，专门进行代码安全审查。请仔细分析提供的代码，识别潜在的安全漏洞和风险。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3
    });

    const tokensUsed = response.usage?.total_tokens || 0;

    // 解析AI响应并转换为SecurityFinding格式
    const findings = this.parseAISecurityResponse(response.choices[0].message.content || '', input);

    return { findings, tokensUsed };
  }

  // 构建安全分析提示词
  private buildSecurityAnalysisPrompt(input: FileAnalysisInput): string {
    return `
请分析以下${input.language}代码的安全性：

文件路径: ${input.filePath}
文件类型: ${input.fileType}

代码内容:
\`\`\`${input.language}
${input.content}
\`\`\`

变更内容 (diff):
\`\`\`diff
${input.diffContent}
\`\`\`

请重点关注以下安全问题：
1. 注入攻击 (SQL注入, XSS, 命令注入等)
2. 身份认证和授权问题
3. 敏感信息泄露
4. 加密和数据保护
5. 输入验证和净化
6. 路径遍历和文件操作安全
7. 业务逻辑漏洞

请以JSON格式返回发现的安全问题，格式如下：
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "type": "问题类型",
      "description": "详细描述",
      "line": 行号,
      "recommendation": "修复建议",
      "cwe": "CWE编号(如果适用)"
    }
  ]
}
`;
  }

  // 加载安全规则
  private loadSecurityRules(): SecurityRule[] {
    return [
      {
        name: 'hardcoded_secrets',
        pattern: /(?:password|passwd|pwd|secret|key|token|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]|['"][A-Za-z0-9+/=]{32,}['"]|sk-[a-zA-Z0-9]{48}|xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/gi,
        severity: 'critical',
        message: '发现疑似硬编码密钥或敏感信息',
        recommendation: '建议将敏感信息移至环境变量或安全的配置管理系统',
        languages: [],
        confidence: 0.9,
        cweId: 'CWE-798'
      },
      {
        name: 'sql_injection_risk',
        pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\+.*['"]|['"].*\+.*(?:SELECT|INSERT|UPDATE|DELETE)/gi,
        severity: 'high',
        message: '发现潜在的SQL注入风险',
        recommendation: '建议使用参数化查询或ORM来防止SQL注入',
        languages: ['php', 'java', 'csharp', 'python', 'javascript', 'typescript'],
        confidence: 0.7,
        cweId: 'CWE-89'
      },
      {
        name: 'xss_risk',
        pattern: /innerHTML\s*=|document\.write\s*\(|eval\s*\(|setTimeout\s*\(.*string|setInterval\s*\(.*string/gi,
        severity: 'high',
        message: '发现潜在的XSS风险',
        recommendation: '避免直接操作DOM，使用安全的模板引擎或框架',
        languages: ['javascript', 'typescript'],
        confidence: 0.6,
        cweId: 'CWE-79'
      },
      {
        name: 'path_traversal',
        pattern: /\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c/gi,
        severity: 'high',
        message: '发现潜在的路径遍历漏洞',
        recommendation: '对文件路径进行严格验证和净化',
        languages: [],
        confidence: 0.8,
        cweId: 'CWE-22'
      },
      {
        name: 'weak_crypto',
        pattern: /MD5|SHA1|DES|RC4|md5|sha1/gi,
        severity: 'medium',
        message: '使用了弱加密算法',
        recommendation: '建议使用更强的加密算法如SHA-256, AES等',
        languages: [],
        confidence: 0.7,
        cweId: 'CWE-327'
      },
      {
        name: 'command_injection',
        pattern: /exec\s*\(|system\s*\(|shell_exec\s*\(|passthru\s*\(|Runtime\.getRuntime\(\)\.exec/gi,
        severity: 'critical',
        message: '发现命令执行功能，可能存在命令注入风险',
        recommendation: '避免直接执行用户输入，使用安全的替代方案',
        languages: ['php', 'java', 'python', 'javascript', 'typescript'],
        confidence: 0.8,
        cweId: 'CWE-78'
      }
    ];
  }

  // 其他辅助方法...
  private isRuleApplicable(rule: SecurityRule, fileType: string, language: string): boolean {
    return rule.languages.length === 0 ||
           rule.languages.includes(language) ||
           rule.languages.includes(fileType);
  }

  private findMatches(rule: SecurityRule, content: string): Array<{ lines: number[]; evidence: string[] }> {
    const matches: Array<{ lines: number[]; evidence: string[] }> = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const lineMatches = line.match(rule.pattern);
      if (lineMatches) {
        matches.push({
          lines: [index + 1],
          evidence: lineMatches.slice(0, 3) // 限制证据数量
        });
      }
    });

    return matches;
  }

  private shouldPerformAIAnalysis(input: FileAnalysisInput, staticFindings: SecurityFinding[]): boolean {
    // 如果静态扫描发现了高风险问题，或者文件较复杂，则进行AI分析
    const hasHighRiskFindings = staticFindings.some(f => f.severity === 'critical' || f.severity === 'high');
    const isComplexFile = input.content.split('\n').length > 100;
    const isSecurityCriticalFile = input.filePath.includes('auth') ||
                                   input.filePath.includes('security') ||
                                   input.filePath.includes('login');

    return hasHighRiskFindings || isComplexFile || isSecurityCriticalFile;
  }

  private calculateConfidence(findings: SecurityFinding[], input: FileAnalysisInput): number {
    if (findings.length === 0) return 0.9; // 高置信度：没有发现问题

    // 基于发现的问题类型和规则置信度计算总体置信度
    const avgRuleConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
    return avgRuleConfidence;
  }

  private parseAISecurityResponse(response: string, input: FileAnalysisInput): SecurityFinding[] {
    try {
      const parsed = JSON.parse(response);
      return parsed.findings.map((finding: any) => ({
        type: 'security',
        severity: finding.severity,
        rule: 'ai_analysis',
        message: finding.description,
        filePath: input.filePath,
        lines: [finding.line || 1],
        evidence: [],
        recommendation: finding.recommendation,
        cweId: finding.cwe,
        confidence: 0.7 // AI分析的置信度稍低
      }));
    } catch (error) {
      logger.warn('Failed to parse AI security response:', error);
      return [];
    }
  }
}

// 安全规则接口
interface SecurityRule {
  name: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  recommendation: string;
  languages: string[]; // 空数组表示适用于所有语言
  confidence?: number;
  cweId?: string;
}

// 输入接口
interface FileAnalysisInput {
  filePath: string;
  content: string;
  diffContent: string;
  fileType: string;
  language: string;
}
```

### 3.2 质量检查Agent

```typescript
class QualityCheckerAgent extends BaseAgent {
  readonly type = AgentType.QUALITY_CHECKER;
  readonly description = '代码质量和最佳实践检查专家';
  readonly supportedLanguages: string[] = [];

  private qualityRules: QualityRule[];

  constructor() {
    super();
    this.qualityRules = this.loadQualityRules();
  }

  async process(
    input: FileAnalysisInput,
    state: GlobalReviewState
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const issues: QualityIssue[] = [];

    try {
      // 1. 通用质量检查
      issues.push(...this.checkFileSize(input));
      issues.push(...this.checkLineLength(input));
      issues.push(...this.checkComplexity(input));
      issues.push(...this.checkNaming(input));
      issues.push(...this.checkComments(input));
      issues.push(...this.checkDuplication(input));

      // 2. 语言特定检查
      if (this.supportsLanguageSpecificChecks(input.language)) {
        issues.push(...this.performLanguageSpecificChecks(input));
      }

      // 3. 基于规则的检查
      issues.push(...this.performRuleBasedChecks(input));

      // 4. 计算置信度
      const confidence = this.calculateQualityConfidence(issues, input);

      return {
        output: issues,
        confidence,
        metadata: {
          processingTime: Date.now() - startTime,
          tokensUsed: 0, // 质量检查主要基于规则，不使用AI
          rulesApplied: this.qualityRules.map(r => r.name)
        }
      };

    } catch (error) {
      return this.handleError(error as Error, 'quality checking');
    }
  }

  // 文件大小检查
  private checkFileSize(input: FileAnalysisInput): QualityIssue[] {
    const lines = input.content.split('\n').length;
    const issues: QualityIssue[] = [];

    if (lines > 1000) {
      issues.push({
        type: 'quality',
        severity: 'high',
        category: 'maintainability',
        message: `文件过大 (${lines} 行)，建议拆分为更小的模块`,
        filePath: input.filePath,
        line: 1,
        suggestion: '考虑将功能拆分到多个文件中，每个文件专注单一职责',
        confidence: 0.9
      });
    } else if (lines > 500) {
      issues.push({
        type: 'quality',
        severity: 'medium',
        category: 'maintainability',
        message: `文件较大 (${lines} 行)，建议考虑重构`,
        filePath: input.filePath,
        line: 1,
        suggestion: '考虑是否可以提取一些功能到独立的模块',
        confidence: 0.7
      });
    }

    return issues;
  }

  // 行长度检查
  private checkLineLength(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = input.content.split('\n');
    let longLineCount = 0;

    lines.forEach((line, index) => {
      if (line.length > 120) {
        longLineCount++;
        if (longLineCount <= 5) { // 限制报告数量
          issues.push({
            type: 'quality',
            severity: 'low',
            category: 'readability',
            message: `行过长 (${line.length} 字符)`,
            filePath: input.filePath,
            line: index + 1,
            suggestion: '考虑拆分长行以提高可读性',
            confidence: 0.8
          });
        }
      }
    });

    if (longLineCount > 5) {
      issues.push({
        type: 'quality',
        severity: 'medium',
        category: 'readability',
        message: `发现 ${longLineCount} 行过长的代码`,
        filePath: input.filePath,
        suggestion: '建议整体检查代码格式，保持合适的行长度',
        confidence: 0.9
      });
    }

    return issues;
  }

  // 复杂度检查
  private checkComplexity(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const complexity = this.calculateCyclomaticComplexity(input.content);

    if (complexity > 20) {
      issues.push({
        type: 'quality',
        severity: 'high',
        category: 'maintainability',
        message: `圈复杂度过高 (${complexity})`,
        filePath: input.filePath,
        suggestion: '考虑拆分复杂的函数或方法，降低圈复杂度',
        confidence: 0.8
      });
    } else if (complexity > 10) {
      issues.push({
        type: 'quality',
        severity: 'medium',
        category: 'maintainability',
        message: `圈复杂度较高 (${complexity})`,
        filePath: input.filePath,
        suggestion: '考虑简化逻辑结构',
        confidence: 0.7
      });
    }

    return issues;
  }

  // 命名检查
  private checkNaming(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = input.content.split('\n');

    // 检查变量命名
    const badNamingPattern = /\b(a|b|c|x|y|z|temp|tmp|data|item|obj|val|foo|bar|baz)\b/gi;

    lines.forEach((line, index) => {
      const matches = line.match(badNamingPattern);
      if (matches && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
        issues.push({
          type: 'quality',
          severity: 'low',
          category: 'readability',
          message: '发现可能的不良命名',
          filePath: input.filePath,
          line: index + 1,
          suggestion: '使用更有意义的变量名',
          confidence: 0.6
        });
      }
    });

    return issues.slice(0, 3); // 限制报告数量
  }

  // 注释检查
  private checkComments(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = input.content.split('\n');
    const codeLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    const commentLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.includes('/*');
    });

    const commentRatio = commentLines.length / Math.max(codeLines.length, 1);

    if (commentRatio < 0.1 && codeLines.length > 50) {
      issues.push({
        type: 'quality',
        severity: 'medium',
        category: 'maintainability',
        message: `注释过少 (${(commentRatio * 100).toFixed(1)}%)`,
        filePath: input.filePath,
        suggestion: '增加必要的注释以提高代码可读性',
        confidence: 0.7
      });
    }

    return issues;
  }

  // 重复代码检查
  private checkDuplication(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = input.content.split('\n');
    const duplicateLines = new Map<string, number[]>();

    // 查找重复行 (忽略空行和注释)
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && trimmed.length > 20) {
        if (!duplicateLines.has(trimmed)) {
          duplicateLines.set(trimmed, []);
        }
        duplicateLines.get(trimmed)!.push(index + 1);
      }
    });

    // 报告重复代码
    for (const [line, lineNumbers] of duplicateLines.entries()) {
      if (lineNumbers.length > 2) {
        issues.push({
          type: 'quality',
          severity: 'medium',
          category: 'maintainability',
          message: `发现重复代码 (${lineNumbers.length} 处)`,
          filePath: input.filePath,
          line: lineNumbers[0],
          suggestion: '考虑提取重复代码到函数或常量',
          confidence: 0.8
        });
      }
    }

    return issues.slice(0, 3); // 限制报告数量
  }

  // 基于规则的检查
  private performRuleBasedChecks(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];

    for (const rule of this.qualityRules) {
      if (this.isRuleApplicable(rule, input.language)) {
        const matches = this.findRuleMatches(rule, input.content);
        for (const match of matches) {
          issues.push({
            type: 'quality',
            severity: rule.severity,
            category: rule.category,
            message: rule.message,
            filePath: input.filePath,
            line: match.line,
            suggestion: rule.suggestion,
            confidence: rule.confidence
          });
        }
      }
    }

    return issues;
  }

  // 语言特定检查
  private performLanguageSpecificChecks(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];

    switch (input.language) {
      case 'javascript':
      case 'typescript':
        issues.push(...this.checkJavaScriptSpecific(input));
        break;
      case 'python':
        issues.push(...this.checkPythonSpecific(input));
        break;
      case 'java':
        issues.push(...this.checkJavaSpecific(input));
        break;
      // 更多语言...
    }

    return issues;
  }

  // JavaScript特定检查
  private checkJavaScriptSpecific(input: FileAnalysisInput): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = input.content.split('\n');

    lines.forEach((line, index) => {
      // 检查 == 而不是 ===
      if (line.includes('==') && !line.includes('===') && !line.includes('!=')) {
        issues.push({
          type: 'quality',
          severity: 'medium',
          category: 'style',
          message: '建议使用严格相等 (===) 而不是 ==',
          filePath: input.filePath,
          line: index + 1,
          suggestion: '使用 === 和 !== 进行严格比较',
          confidence: 0.9
        });
      }

      // 检查 var 而不是 let/const
      if (line.match(/\bvar\s+/)) {
        issues.push({
          type: 'quality',
          severity: 'low',
          category: 'style',
          message: '建议使用 let 或 const 而不是 var',
          filePath: input.filePath,
          line: index + 1,
          suggestion: '使用 let 或 const 获得更好的作用域控制',
          confidence: 0.8
        });
      }
    });

    return issues;
  }

  // 计算圈复杂度的简化实现
  private calculateCyclomaticComplexity(content: string): number {
    // 简化的圈复杂度计算：统计决策点
    const complexityKeywords = /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g;
    const matches = content.match(complexityKeywords);
    return (matches?.length || 0) + 1; // +1 for the base path
  }

  // 加载质量规则
  private loadQualityRules(): QualityRule[] {
    return [
      {
        name: 'console_log',
        pattern: /console\.log\s*\(/gi,
        severity: 'low',
        category: 'style',
        message: '发现调试语句',
        suggestion: '移除调试语句或使用适当的日志库',
        languages: ['javascript', 'typescript'],
        confidence: 0.9
      },
      {
        name: 'todo_comment',
        pattern: /\/\/\s*TODO|\/\*\s*TODO/gi,
        severity: 'low',
        category: 'maintainability',
        message: '发现TODO注释',
        suggestion: '考虑完成TODO项目或创建issue跟踪',
        languages: [],
        confidence: 0.8
      },
      {
        name: 'magic_numbers',
        pattern: /\b\d{2,}\b/g,
        severity: 'low',
        category: 'maintainability',
        message: '发现魔法数字',
        suggestion: '考虑使用有意义的常量替换魔法数字',
        languages: [],
        confidence: 0.6
      }
    ];
  }

  // 辅助方法
  private supportsLanguageSpecificChecks(language: string): boolean {
    return ['javascript', 'typescript', 'python', 'java'].includes(language);
  }

  private isRuleApplicable(rule: QualityRule, language: string): boolean {
    return rule.languages.length === 0 || rule.languages.includes(language);
  }

  private findRuleMatches(rule: QualityRule, content: string): Array<{ line: number }> {
    const matches: Array<{ line: number }> = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        matches.push({ line: index + 1 });
      }
    });

    return matches.slice(0, 5); // 限制每个规则的报告数量
  }

  private calculateQualityConfidence(issues: QualityIssue[], input: FileAnalysisInput): number {
    if (issues.length === 0) return 0.9;

    // 基于问题的严重性和数量计算置信度
    const severityWeights = { low: 0.3, medium: 0.6, high: 0.9 };
    const avgSeverity = issues.reduce((sum, issue) => {
      return sum + severityWeights[issue.severity];
    }, 0) / issues.length;

    return Math.max(0.5, 1 - avgSeverity * 0.3);
  }
}

// 质量规则接口
interface QualityRule {
  name: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high';
  category: 'maintainability' | 'readability' | 'performance' | 'style';
  message: string;
  suggestion: string;
  languages: string[];
  confidence: number;
}
```

## 4. 配置管理

### 4.1 配置接口定义

```typescript
interface MultiAgentConfig {
  // 框架配置
  framework: {
    maxConcurrency: number;
    timeout: number;
    retryAttempts: number;
    enableCaching: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };

  // Agent配置
  agents: {
    security: {
      enabled: boolean;
      aiAnalysisThreshold: 'low' | 'medium' | 'high';
      customRules: SecurityRule[];
      excludePatterns: string[];
    };

    quality: {
      enabled: boolean;
      thresholds: {
        maxFileSize: number;
        maxLineLength: number;
        maxComplexity: number;
        minCommentRatio: number;
      };
      customRules: QualityRule[];
      languageSpecific: boolean;
    };

    language: {
      supportedLanguages: string[];
      enableASTAnalysis: boolean;
      maxContextSize: number;
      aiEnhancedAnalysis: boolean;
    };
  };

  // 输出配置
  output: {
    includeConfidenceScores: boolean;
    maxIssuesPerCategory: number;
    aggregationStrategy: 'weighted' | 'majority' | 'consensus';
    includeUncertaintyReport: boolean;
    verboseMode: boolean;
  };

  // 性能配置
  performance: {
    tokenBudget: number;
    cacheTTL: number;
    parallelAgentLimit: number;
    timeoutPerAgent: number;
  };
}
```

### 4.2 默认配置

```typescript
const DEFAULT_MULTIAGENT_CONFIG: MultiAgentConfig = {
  framework: {
    maxConcurrency: 4,
    timeout: 300000, // 5分钟
    retryAttempts: 2,
    enableCaching: true,
    logLevel: 'info'
  },

  agents: {
    security: {
      enabled: true,
      aiAnalysisThreshold: 'medium',
      customRules: [],
      excludePatterns: ['test/', 'spec/', '__tests__/']
    },

    quality: {
      enabled: true,
      thresholds: {
        maxFileSize: 1000,
        maxLineLength: 120,
        maxComplexity: 20,
        minCommentRatio: 0.1
      },
      customRules: [],
      languageSpecific: true
    },

    language: {
      supportedLanguages: ['typescript', 'javascript', 'python', 'java', 'go'],
      enableASTAnalysis: false,
      maxContextSize: 8000,
      aiEnhancedAnalysis: true
    }
  },

  output: {
    includeConfidenceScores: true,
    maxIssuesPerCategory: 10,
    aggregationStrategy: 'weighted',
    includeUncertaintyReport: true,
    verboseMode: false
  },

  performance: {
    tokenBudget: 50000,
    cacheTTL: 3600, // 1小时
    parallelAgentLimit: 3,
    timeoutPerAgent: 60000 // 1分钟
  }
};
```

## 5. 错误处理和监控

### 5.1 错误处理策略

```typescript
class ErrorHandler {
  static async handleAgentError(
    agentType: AgentType,
    error: Error,
    context: any,
    retryCount: number
  ): Promise<AgentResult> {
    logger.error(`Agent ${agentType} failed (attempt ${retryCount + 1}):`, {
      error: error.message,
      stack: error.stack,
      context
    });

    // 根据Agent类型决定降级策略
    switch (agentType) {
      case AgentType.SECURITY_SCANNER:
        // 降级策略：如果AI分析失败，尝试运行一个基础的、基于正则表达式的扫描
        logger.warn(`SecurityScanner failed. Falling back to basic regex scan.`);
        const fallbackFindings = this.runFallbackSecurityScan(context.input);
        return {
          output: fallbackFindings,
          confidence: 0.4, // 降级方案的置信度较低
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            errors: [`安全扫描失败: ${error.message}`],
            statusMessage: '执行降级：仅完成基础正则扫描'
          }
        };

      case AgentType.LANGUAGE_SPECIALIST:
        // 降级策略：如果AST分析失败，可以跳过并标记为不确定
        return {
          output: { insights: 'AST analysis failed, unable to provide language-specific insights.' },
          confidence: 0.2,
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            errors: [`语言专家Agent失败: ${error.message}`],
            statusMessage: '执行跳过：无法进行深度语言分析'
          }
        };

      default:
        // 对于其他Agent，返回一个标准的失败结果
        return {
          output: [],
          confidence: 0,
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            errors: [`Agent ${agentType} 执行失败: ${error.message}`]
          }
        };
    }
  }

  // 备用安全扫描
  private static runFallbackSecurityScan(input: any): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const hardcodedSecretPattern = /(?:password|secret|key|token)\s*[:=]\s*['"][^'"]+/i;

    if (input && input.content) {
        const lines = input.content.split('\n');
        lines.forEach((line: string, index: number) => {
            if (hardcodedSecretPattern.test(line)) {
                findings.push({
                    type: 'security',
                    severity: 'high',
                    rule: 'fallback_hardcoded_secret',
                    message: '发现疑似硬编码密钥 (降级模式)',
                    filePath: input.filePath,
                    lines: [index + 1],
                    evidence: [line.trim()],
                    recommendation: '请确认是否为敏感信息并考虑使用安全的方式存储',
                    confidence: 0.5
                });
            }
        });
    }
    return findings;
  }

  static createPartialResult(
    availableResults: Partial<ComprehensiveReviewResult>,
    errors: string[]
  ): ComprehensiveReviewResult {
    return {
      summary: `代码审查部分完成，部分Agent执行失败: ${errors.join(', ')}`,
      overallScore: 5, // 中等分数表示不确定
      riskLevel: 'medium',
      findings: {
        security: availableResults.findings?.security || [],
        quality: availableResults.findings?.quality || [],
        complexity: availableResults.findings?.complexity || [],
        language: availableResults.findings?.language || []
      },
      lineComments: availableResults.lineComments || [],
      recommendations: availableResults.recommendations || {
        critical: ['系统部分功能异常，建议手动检查'],
        high: [],
        medium: [],
        low: []
      },
      metadata: {
        totalFilesAnalyzed: 0,
        totalAgentsUsed: 0,
        averageConfidence: 0.5,
        processingTime: 0,
        uncertainAreas: ['系统执行异常，结果可能不完整']
      }
    };
  }
}
```

### 5.2 性能监控

```typescript
class PerformanceMonitor {
  private metrics: Map<string, MetricData> = new Map();
  private tokenBudget: number;
  private tokensConsumed: number = 0;

  constructor(config: MultiAgentConfig) {
    this.tokenBudget = config.performance.tokenBudget;
  }

  recordAgentExecution(
    agentType: AgentType,
    startTime: number,
    endTime: number,
    tokensUsed: number,
    success: boolean,
    timedOut: boolean = false
  ): void {
    const duration = endTime - startTime;
    const key = `agent_${agentType}`;

    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        totalExecutions: 0,
        totalDuration: 0,
        totalTokens: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        avgDuration: 0,
        avgTokens: 0,
        successRate: 0
      });
    }

    const metric = this.metrics.get(key)!;
    metric.totalExecutions++;
    metric.totalDuration += duration;
    metric.totalTokens += tokensUsed;
    this.tokensConsumed += tokensUsed;

    if (success) {
      metric.successCount++;
    } else {
      metric.errorCount++;
    }
    if (timedOut) {
      metric.timeoutCount++;
    }

    // 更新平均值
    metric.avgDuration = metric.totalDuration / metric.totalExecutions;
    metric.avgTokens = metric.totalTokens / metric.totalExecutions;
    metric.successRate = metric.successCount / metric.totalExecutions;
  }

  isTokenBudgetExceeded(): boolean {
    return this.tokensConsumed > this.tokenBudget;
  }

  getMetrics(): Record<string, MetricData> {
    return Object.fromEntries(this.metrics);
  }

  generateReport(): string {
    let report = '\n=== MultiAgent性能报告 ===\n';
    report += `Token预算: ${this.tokenBudget}, 已消耗: ${this.tokensConsumed}\n`;
    if (this.isTokenBudgetExceeded()) {
      report += `状态: 超出预算!\n`;
    }

    for (const [key, metric] of this.metrics.entries()) {
      report += `\n${key}:\n`;
      report += `  执行次数: ${metric.totalExecutions}\n`;
      report += `  平均耗时: ${metric.avgDuration.toFixed(2)}ms\n`;
      report += `  平均Token: ${metric.avgTokens.toFixed(0)}\n`;
      report += `  成功率: ${(metric.successRate * 100).toFixed(1)}%\n`;
      report += `  超时次数: ${metric.timeoutCount}\n`;
    }

    return report;
  }
}

interface MetricData {
  totalExecutions: number;
  totalDuration: number;
  totalTokens: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  avgDuration: number;
  avgTokens: number;
  successRate: number;
}
```

---

*本文档版本: v1.1*
*创建日期: 2025-01-09*
*最后更新: 2025-10-09*
