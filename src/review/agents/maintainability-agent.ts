import type { LLMGateway } from '../../llm/gateway';
import type { LearningSystem } from '../learning/learning-system';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class MaintainabilityAgent extends SpecialistAgent {
  constructor(gateway: LLMGateway, toolRegistry?: ToolRegistry, learningSystem?: LearningSystem) {
    super(
      gateway,
      'maintainability',
      'Maintainability Agent',
      '可维护性、复杂度、接口破坏风险和可测试性不足',
      toolRegistry,
      learningSystem
    );
  }
}
