import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { agentSessionRepository } from '../../agent-kernel/session';
import { reviewEngine } from '../../review/engine';
import { adminController } from '../admin';

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/admin/api', adminController.protectedRoutes);
  return app;
}

describe('admin review runs route', () => {
  const originalGetRunDetails = reviewEngine.getRunDetails;
  const originalGetSessionTreeByRunId = agentSessionRepository.getSessionTreeByRunId;

  afterEach(() => {
    reviewEngine.getRunDetails = originalGetRunDetails;
    agentSessionRepository.getSessionTreeByRunId = originalGetSessionTreeByRunId;
  });

  test('GET /admin/api/review/runs/:runId returns run details with sessionTree', async () => {
    const mockRunDetails = {
      run: {
        id: 'run-123',
        status: 'succeeded',
        owner: 'test-owner',
        repo: 'test-repo',
        createdAt: '2026-05-25T00:00:00.000Z',
      },
      steps: [],
      findings: [],
      comments: [],
    };

    const mockSessionTree = {
      id: 'session-123',
      agentType: 'review-main-agent',
      model: 'gpt-main',
      status: 'completed',
      messages: [],
      toolCalls: [],
      invocations: [],
    };

    reviewEngine.getRunDetails = async (runId) => {
      if (runId === 'run-123') {
        return mockRunDetails as any;
      }
      return null;
    };

    agentSessionRepository.getSessionTreeByRunId = (runId) => {
      if (runId === 'run-123') {
        return mockSessionTree as any;
      }
      return null;
    };

    const app = createTestApp();
    const response = await app.request('http://localhost/admin/api/review/runs/run-123');
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.run.id).toBe('run-123');
    expect(payload.sessionTree.id).toBe('session-123');
    expect(payload.sessionTree.agentType).toBe('review-main-agent');
  });

  test('GET /admin/api/review/runs/:runId returns 404 if run not found', async () => {
    reviewEngine.getRunDetails = async () => null;

    const app = createTestApp();
    const response = await app.request('http://localhost/admin/api/review/runs/missing-run');
    expect(response.status).toBe(404);
  });
});
