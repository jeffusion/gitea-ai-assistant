import OpenAI from 'openai';
import type { LearningSystem } from '../learning/learning-system';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class ReliabilityAgent extends SpecialistAgent {
  constructor(
    openai: OpenAI,
    model: string,
    toolRegistry?: ToolRegistry,
    learningSystem?: LearningSystem
  ) {
    super(
      openai,
      model,
      'reliability',
      'Reliability Agent',
      '错误处理、重试策略、幂等性、并发一致性和资源释放',
      toolRegistry,
      learningSystem
    );
  }
}
