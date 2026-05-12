import type { LLMGateway } from '../../llm/gateway';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class CorrectnessAgent extends SpecialistAgent {
  constructor(gateway: LLMGateway, toolRegistry?: ToolRegistry) {
    super(
      gateway,
      'correctness',
      'Correctness Agent',
      '业务逻辑正确性、边界条件、空值处理和明显bug',
      toolRegistry
    );
  }
}
