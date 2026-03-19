import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

type Violation = {
  file: string;
  line: number;
  reason: string;
  snippet: string;
};

type Rule = {
  reason: string;
  regex: RegExp;
};

type Requirement = {
  file: string;
  reason: string;
  needles: string[];
};

const rules: Rule[] = [
  { reason: 'hardcoded zinc utility', regex: /\b(?:bg|text|border)-zinc-\d{2,3}\b/ },
  { reason: 'hardcoded white-alpha border', regex: /\bborder-white\/\d+\b/ },
  { reason: 'hardcoded black overlay', regex: /\bbg-black\/\d+\b/ },
  { reason: 'inline rgba color literal', regex: /rgba\(/ },
  { reason: 'inline rgb color literal', regex: /rgb\(/ },
  { reason: 'hex color literal', regex: /#[0-9a-fA-F]{3,8}\b/ },
  { reason: 'legacy red semantic marker', regex: /text-red-500/ },
  { reason: 'primary-tinted hover on non-primary surfaces', regex: /\b(?:hover:bg-primary\/(?:[1-8]0)|group-hover:bg-primary\/(?:[1-8]0))\b/ },
];

const requirements: Requirement[] = [
  {
    file: 'src/index.css',
    reason: 'theme token and utility baseline',
    needles: [
      '--success:',
      '--warning:',
      '--danger:',
      '--info:',
      '--surface-muted:',
      '--surface-elevated:',
      '--surface-overlay:',
      '.theme-glow-primary',
      '.theme-surface-overlay',
      '.theme-sticky-bar',
      '.theme-page-frame',
      '.theme-page-actions',
      '.theme-page-content',
      '.theme-card-shell',
      '.theme-card-header',
      '.theme-card-content',
      '.theme-error-panel',
      '.theme-dialog-panel',
      '.theme-dialog-header',
      '.theme-dialog-body',
      '.theme-dialog-footer',
    ],
  },
  {
    file: 'tailwind.config.js',
    reason: 'semantic color mapping in Tailwind',
    needles: ['danger:', 'success:', 'warning:', 'info:'],
  },
  {
    file: 'src/components/llm/ProviderDialog.tsx',
    reason: 'modal overlay must use semantic utility',
    needles: ['theme-surface-overlay', 'theme-dialog-panel', 'theme-dialog-header', 'theme-dialog-body', 'theme-dialog-footer'],
  },
  {
    file: 'src/components/llm/TestResultDialog.tsx',
    reason: 'modal overlay must use semantic utility',
    needles: ['theme-surface-overlay', 'theme-dialog-panel', 'theme-dialog-header', 'theme-dialog-body', 'theme-dialog-footer'],
  },
  {
    file: '../docs/design/ui-theme-language.md',
    reason: 'design language documentation baseline',
    needles: ['强制规则', '页面级统一约束', 'destructive 与 danger 的约定', 'theme-surface-overlay'],
  },
  {
    file: 'src/components/ConfigManager.tsx',
    reason: 'system config page should use unified page shell utilities',
    needles: ['theme-page-frame', 'theme-page-actions', 'theme-page-content', 'theme-error-panel'],
  },
  {
    file: 'src/components/ReviewConfigPage.tsx',
    reason: 'review config page should use unified page shell utilities',
    needles: ['theme-page-frame', 'theme-page-actions', 'theme-page-content', 'theme-card-shell', 'theme-error-panel'],
  },
];

const violations: Violation[] = [];

const addViolation = (file: string, line: number, reason: string, snippet: string) => {
  violations.push({ file: relative(process.cwd(), file), line, reason, snippet });
};

const scanSourceFiles = async () => {
  const glob = new Glob('src/**/*.tsx');

  for await (const file of glob.scan('.')) {
    const absoluteFile = resolve(process.cwd(), file);
    const content = await Bun.file(absoluteFile).text();
    const lines = content.split(/\r?\n/);

    lines.forEach((lineContent, index) => {
      rules.forEach((rule) => {
        if (rule.regex.test(lineContent)) {
          addViolation(absoluteFile, index + 1, rule.reason, lineContent.trim());
        }
      });
    });
  }
};

const verifyRequirements = async () => {
  for (const requirement of requirements) {
    const absoluteFile = resolve(process.cwd(), requirement.file);

    if (!existsSync(absoluteFile)) {
      addViolation(absoluteFile, 1, requirement.reason, 'required file missing');
      continue;
    }

    const content = await Bun.file(absoluteFile).text();
    requirement.needles.forEach((needle) => {
      if (!content.includes(needle)) {
        addViolation(absoluteFile, 1, requirement.reason, `missing token/pattern: ${needle}`);
      }
    });
  }
};

const printResult = () => {
  if (violations.length === 0) {
    console.log('✅ UI regression guard passed');
    return;
  }

  console.error(`❌ UI regression guard failed with ${violations.length} issue(s):`);
  violations.forEach((violation) => {
    console.error(`- ${violation.file}:${violation.line} [${violation.reason}] ${violation.snippet}`);
  });
  process.exit(1);
};

await scanSourceFiles();
await verifyRequirements();
printResult();
