import type { LLMGateway } from '../../llm/gateway';
import type { LearningSystem } from '../learning/learning-system';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class ReliabilityAgent extends SpecialistAgent {
  constructor(gateway: LLMGateway, toolRegistry?: ToolRegistry, learningSystem?: LearningSystem) {
    super(
      gateway,
      'reliability',
      'Reliability Agent',
      '错误处理、重试策略、幂等性、并发一致性和资源释放',
      toolRegistry,
      learningSystem
    );
  }
}
