// =================================================================
// 核心接口定义
// 定义来源: docs/MULTIAGENT_IMPLEMENTATION.md
// =================================================================

/**
 * Agent类型枚举
 */
export enum AgentType {
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
  TYPESCRIPT_SPECIALIST = 'typescript_specialist',
  PYTHON_SPECIALIST = 'python_specialist',
  JAVA_SPECIALIST = 'java_specialist',
  GO_SPECIALIST = 'go_specialist',

  // 整合与生成Agent
  REFINEMENT_SYNTHESIS = 'refinement_synthesis',
  FINAL_REPORT_GENERATOR = 'final_report_generator',
}

/**
 * Agent状态
 */
export interface AgentState {
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

/**
 * Agent执行结果
 */
export interface AgentResult {
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

/**
 * 安全发现
 */
export interface SecurityFinding {
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

/**
 * 质量问题
 */
export interface QualityIssue {
  type: 'quality';
  severity: 'low' | 'medium' | 'high';
  category: 'maintainability' | 'readability' | 'performance' | 'style';
  message: string;
  filePath: string;
  line?: number;
  suggestion: string;
  confidence: number;
}

/**
 * 模式发现
 */
export interface PatternFinding {
  message: string;
  filePath: string;
  line: number;
}

/**
 * 复杂度指标
 */
export interface ComplexityMetric {
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

/**
 * 语言洞察
 */
export interface LanguageInsight {
  language: string;
  filePath: string;
  patterns: {
    idioms: PatternFinding[];
    antiPatterns: PatternFinding[];
    bestPractices: PatternFinding[];
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

/**
 * Gitea行评论 (在文档中被引用但未定义，此处为基础实现)
 * @interface LineComment
 */
export interface LineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * 综合审查结果
 */
export interface ComprehensiveReviewResult {
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


/**
 * PR上下文信息
 */
export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  diffContent: string;
  createdAt: string; // ISO 8601 format
}

/**
 * 全局状态管理
 */
/**
 * 单个文件的分析数据
 */
export interface FileAnalysisData {
  filePath: string;
  rawContent: string;
  diffContent: string;
  fileType: string;
  language: string;
  analysisResults?: Partial<Record<AgentType, any>>;
}

export class GlobalReviewState {
  prContext: PRContext;

  fileAnalysis: {
    [filePath: string]: FileAnalysisData;
  };

  crossFileDependencies: {
    dependencies: Record<string, string[]>;
    dependents: Record<string, string[]>;
  };

  agentStates: Record<string, AgentState>;

  intermediateResults: {
    securityFindings: SecurityFinding[];
    qualityIssues: QualityIssue[];
    complexityMetrics: ComplexityMetric[];
    languageInsights: LanguageInsight[];
  };

  finalResult?: ComprehensiveReviewResult;

  constructor(prContext: PRContext) {
    this.prContext = prContext;
    this.fileAnalysis = {};
    this.agentStates = {};
    this.crossFileDependencies = { dependencies: {}, dependents: {} };
    this.intermediateResults = {
      securityFindings: [],
      qualityIssues: [],
      complexityMetrics: [],
      languageInsights: [],
    };
    this.finalResult = undefined;
  }
}

/**
 * Agent基类
 */
export abstract class BaseAgent {
  abstract type: AgentType;
  abstract description: string;

  abstract process(
    // The `input` can be of any type, allowing flexibility for different agents.
    // For file-specific agents, this will typically be `FileAnalysisData`.
    // For global agents, this might be the entire `GlobalReviewState`.
    input: any,
    state: GlobalReviewState,
  ): Promise<AgentResult>;

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: true };
  }
}
