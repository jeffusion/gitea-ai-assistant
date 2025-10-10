import {
  AgentType,
  BaseAgent,
  AgentResult,
  FileAnalysisData,
  GlobalReviewState,
  LanguageInsight,
  PatternFinding,
} from '../types';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface PmdViolation {
  beginline: number;
  endline: number;
  begincolumn: number;
  endcolumn: number;
  description: string;
  rule: string;
  ruleset: string;
  priority: number;
  externalInfoUrl: string;
}

interface PmdReport {
  files: {
    filename: string;
    violations: PmdViolation[];
  }[];
}

export class JavaSpecialistAgent extends BaseAgent {
  type: AgentType = AgentType.JAVA_SPECIALIST;
  description: string = 'Provides in-depth analysis for Java code.';

  private async analyzeJavaCode(
    code: string,
    filePath: string,
  ): Promise<PmdReport> {
    const tempFileName = `temp_${path.basename(filePath)}`;
    const tempFilePath = path.join('/tmp', tempFileName);
    let report: PmdReport = { files: [] };

    try {
      await fs.writeFile(tempFilePath, code);
      const command = `pmd check -d ${tempFilePath} -R rulesets/java/quickstart.xml -f json`;
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        console.error(`PMD analysis error for ${filePath}:`, stderr);
      }

      if (stdout) {
        report = JSON.parse(stdout) as PmdReport;
      }
    } catch (error: any) {
      if (error.code === 127 || (error.stderr && error.stderr.includes('command not found'))) {
        throw new Error('PMD is not installed or not in PATH.');
      }
      console.error(`Failed to execute PMD for ${filePath}:`, error);
    } finally {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.error(`Failed to clean up temporary file ${tempFilePath}:`, cleanupError);
      }
    }
    return report;
  }

  private parsePmdReport(report: PmdReport, originalFilePath: string): PatternFinding[] {
    const findings: PatternFinding[] = [];
    for (const file of report.files) {
      for (const violation of file.violations) {
        if (violation.rule === 'UnusedLocalVariable') {
          findings.push({
            message: violation.description,
            filePath: originalFilePath,
            line: violation.beginline,
          });
        }
      }
    }
    return findings;
  }

  async process(
    fileData: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const insight: LanguageInsight = {
      language: 'java',
      filePath: fileData.filePath,
      patterns: {
        idioms: [],
        antiPatterns: [],
        bestPractices: [],
      },
      dependencies: {
        direct: [],
        circular: [],
        unused: [],
      },
    };

    let errors: string[] = [];
    let confidence = 0.98;

    try {
      const pmdReport = await this.analyzeJavaCode(fileData.rawContent, fileData.filePath);
      const unusedVars = this.parsePmdReport(pmdReport, fileData.filePath);
      insight.patterns.bestPractices.push(...unusedVars);

      if (unusedVars.length > 0) {
        confidence = 0.95;
      }
    } catch (error: any) {
      errors.push(error.message);
      confidence = 0.3;
    }

    const processingTime = Date.now() - startTime;

    return {
      output: insight,
      confidence,
      metadata: {
        processingTime,
        tokensUsed: 0,
        errors,
      },
    };
  }
}
