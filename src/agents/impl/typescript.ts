import * as ts from 'typescript';
import {
  AgentType,
  BaseAgent,
  AgentResult,
  FileAnalysisData,
  GlobalReviewState,
  LanguageInsight,
  PatternFinding,
} from '../types';

export class TypeScriptSpecialistAgent extends BaseAgent {
  type: AgentType = AgentType.TYPESCRIPT_SPECIALIST;
  description: string =
    'Provides in-depth analysis for TypeScript and JavaScript code.';

  private analyzeTypeScript(
    filePath: string,
    fileContent: string,
  ): PatternFinding[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      fileContent,
      ts.ScriptTarget.Latest,
      true,
    );

    const findings: PatternFinding[] = [];
    const exportedFunctions: { name: string; line: number }[] = [];
    const calledFunctions: Set<string> = new Set();

    const visit = (node: ts.Node) => {
      // 1. Find all exported functions
      if (
        ts.isFunctionDeclaration(node) &&
        node.modifiers?.some(
          modifier => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) &&
        node.name
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        exportedFunctions.push({ name: node.name.text, line });
      }

      // 2. Find all function calls
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          calledFunctions.add(expression.text);
        }
      }

      // 3. Find 'any' keyword usage
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push({
          message: 'Explicit use of `any` type detected.',
          filePath,
          line,
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Add findings for unused exported functions
    exportedFunctions.forEach(({ name, line }) => {
      if (!calledFunctions.has(name)) {
        findings.push({
          message: `Unused exported function: '${name}'`,
          filePath,
          line,
        });
      }
    });

    return findings;
  }

  async process(
    input: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const antiPatterns = this.analyzeTypeScript(
      input.filePath,
      input.rawContent,
    );

    const confidence = antiPatterns.length > 0 ? 0.85 : 0.9;

    const insight: LanguageInsight = {
      language: 'typescript',
      filePath: input.filePath,
      patterns: {
        idioms: [],
        bestPractices: [],
        antiPatterns,
      },
      dependencies: {
        direct: [],
        circular: [],
        unused: [],
      },
    };

    return {
      output: insight,
      confidence,
      metadata: {
        processingTime: 0,
        tokensUsed: 0,
      },
    };
  }
}
