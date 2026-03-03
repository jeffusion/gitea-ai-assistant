import OpenAI from 'openai';
import type { LearningSystem } from '../learning/learning-system';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class CorrectnessAgent extends SpecialistAgent {
  constructor(
    openai: OpenAI,
    model: string,
    toolRegistry?: ToolRegistry,
    learningSystem?: LearningSystem
  ) {
    super(
      openai,
      model,
      'correctness',
      'Correctness Agent',
      '业务逻辑正确性、边界条件、空值处理和明显bug',
      toolRegistry,
      learningSystem
    );
  }
}
