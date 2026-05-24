import { describe, expect, test } from 'bun:test';
import { dedupeFindingsForReview } from '../review-kernel-runtime';
import type { PendingFinding } from '../review-kernel-state';

function finding(overrides: Partial<PendingFinding>): PendingFinding {
  return {
    fingerprint: `fp-${overrides.category}-${overrides.line}-${overrides.title}`,
    category: 'correctness',
    severity: 'medium',
    confidence: 0.9,
    path: 'components/business/SRv6/SRv6SlicePanel.vue',
    line: 1,
    title: '问题',
    detail: '详情',
    evidence: '证据',
    suggestion: '建议',
    ...overrides,
  };
}

describe('dedupeFindingsForReview', () => {
  test('collapses duplicate slice deletion findings from one autonomous full review result', () => {
    const result = dedupeFindingsForReview([
      finding({
        category: 'correctness',
        severity: 'high',
        confidence: 0.99,
        line: 186,
        title: '切片删除仅修改本地列表，未持久化到后端',
        detail:
          '删除按钮绑定 removeSliceAt，只从 slices 数组 splice，没有调用后端 DELETE，刷新后恢复。',
        evidence: 'removeSliceAt -> slices.value.splice(index, 1)',
        suggestion: '调用 network-slices 删除接口后重新加载列表。',
      }),
      finding({
        category: 'security',
        severity: 'high',
        confidence: 0.98,
        line: 210,
        title: '网络切片删除仅修改前端状态，未提交持久化',
        detail: '切片删除操作直接 splice 掉 slices 本地数组，没有调用后端接口，真实数据未删除。',
        evidence: 'const removeSliceAt = () => slices.value.splice(index, 1)',
        suggestion: '使用后端 network-slices 删除接口并刷新数据。',
      }),
      finding({
        category: 'quality',
        severity: 'high',
        confidence: 0.97,
        line: 232,
        title: '网络切片“删除”仅本地移除，未调用后端删除接口',
        detail: '点击删除只修改本地状态，刷新页面会恢复原数据。',
        evidence: 'slices.value.splice(index, 1)',
        suggestion: '调用 DELETE 接口并处理失败提示。',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ category: 'correctness', line: 186 });
  });

  test('keeps distinct root causes in the same file', () => {
    const result = dedupeFindingsForReview([
      finding({
        category: 'correctness',
        severity: 'high',
        confidence: 0.99,
        line: 186,
        title: '切片删除仅修改本地列表，未持久化到后端',
        detail: '删除按钮只 splice 本地 slices 数组，没有调用后端 DELETE。',
        evidence: 'removeSliceAt -> slices.value.splice(index, 1)',
        suggestion: '调用后端删除接口。',
      }),
      finding({
        category: 'quality',
        severity: 'medium',
        confidence: 0.91,
        line: 231,
        title: '表格排序后按列表索引删除可能删错记录',
        detail: '表格使用 sortedSlices 排序数据源，但 removeSliceAt 使用 $index 删除原始 slices。',
        evidence: 'sortedSlices 与 removeSliceAt($index)',
        suggestion: '按 row.uuid 查找真实索引后删除。',
      }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.title)).toContain('切片删除仅修改本地列表，未持久化到后端');
    expect(result.map((item) => item.title)).toContain('表格排序后按列表索引删除可能删错记录');
  });

  test('keeps separate local-delete issues when locations and text differ', () => {
    const result = dedupeFindingsForReview([
      finding({
        category: 'correctness',
        severity: 'high',
        confidence: 0.97,
        line: 80,
        title: '用户标签删除仅修改本地数组，未调用后端接口',
        detail: 'removeTag 只对 tagRows 执行 splice，没有调用标签删除 API，刷新后标签会恢复。',
        evidence: 'removeTag -> tagRows.value.splice(index, 1)',
        suggestion: '调用 tag 删除接口后刷新标签列表。',
      }),
      finding({
        category: 'quality',
        severity: 'medium',
        confidence: 0.91,
        line: 420,
        title: '告警规则删除只更新本地列表，未持久化到后端',
        detail: 'deleteAlarmRule 只从 alarmRules 本地数组移除元素，没有请求告警规则删除接口。',
        evidence: 'deleteAlarmRule -> alarmRules.value.splice(index, 1)',
        suggestion: '调用 alarm-rule 删除接口并处理失败提示。',
      }),
    ]);

    expect(result).toHaveLength(2);
  });

  test('sorts deduped findings deterministically when weights tie', () => {
    const result = dedupeFindingsForReview([
      finding({
        category: 'quality',
        severity: 'medium',
        confidence: 0.8,
        path: 'src/z.ts',
        line: 30,
        title: 'Z issue',
      }),
      finding({
        category: 'quality',
        severity: 'medium',
        confidence: 0.8,
        path: 'src/a.ts',
        line: 10,
        title: 'A issue',
      }),
      finding({
        category: 'quality',
        severity: 'medium',
        confidence: 0.8,
        path: 'src/b.ts',
        line: 5,
        title: 'B issue',
      }),
    ]);

    expect(result.map((item) => `${item.path}:${item.line}:${item.title}`)).toEqual([
      'src/a.ts:10:A issue',
      'src/b.ts:5:B issue',
      'src/z.ts:30:Z issue',
    ]);
  });
});
