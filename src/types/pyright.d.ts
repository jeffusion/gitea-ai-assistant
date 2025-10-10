declare module 'pyright' {
  export enum DiagnosticCategory {
    Error = 'error',
    Warning = 'warning',
    Information = 'information',
    Hint = 'hint',
    ReportUnusedImport = 'reportUnusedImport',
  }

  export interface Diagnostic {
    category: DiagnosticCategory;
    message: string;
    range: {
      start: {
        line: number;
        character: number;
      };
      end: {
        line: number;
        character: number;
      };
    };
  }

  export interface PyrightAnalyzer {
    setSourceFile(filePath: string, content: string): void;
    getDiagnostics(): Diagnostic[];
  }

  export function createAnalyzer(): PyrightAnalyzer;
}
