import { describe, expect, test } from 'bun:test';
import { DiffExtractor } from '../context/diff-extractor';

function createExtractor(): DiffExtractor {
  return new DiffExtractor({} as any, {} as any, 1000, 200, 10000);
}

describe('DiffExtractor.parseDiff', () => {
  test('captures added, context, and deleted lines', () => {
    const extractor = createExtractor();
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`;

    const parsed = extractor.parseDiff(diff);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/a.ts');

    const addLine = parsed[0].changes.find((change) => change.type === 'add');
    const deleteLine = parsed[0].changes.find((change) => change.type === 'delete');

    expect(addLine).toBeDefined();
    expect(deleteLine).toBeDefined();
    expect(deleteLine?.oldLineNumber).toBe(2);
  });

  test('respects allowedPaths filter', () => {
    const extractor = createExtractor();
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-const b = 1;
+const b = 2;`;

    const parsed = extractor.parseDiff(diff, new Set(['src/b.ts']));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/b.ts');
  });
});
