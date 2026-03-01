import OpenAI from 'openai';
import { SpecialistAgent } from './specialist-agent';
import { ToolRegistry } from '../tools/registry';
import type { LearningSystem } from '../learning/learning-system';

export class SecurityAgent extends SpecialistAgent {
  constructor(openai: OpenAI, model: string, toolRegistry?: ToolRegistry, learningSystem?: LearningSystem) {
    super(openai, model, 'security', 'Security Agent', '注入漏洞、权限绕过、敏感信息泄露、反序列化和输入校验缺失', toolRegistry, learningSystem);
  }
}
