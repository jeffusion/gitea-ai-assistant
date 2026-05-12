import type { LLMGateway } from '../../llm/gateway';
import { ToolRegistry } from '../tools/registry';
import { SpecialistAgent } from './specialist-agent';

export class SecurityAgent extends SpecialistAgent {
  constructor(gateway: LLMGateway, toolRegistry?: ToolRegistry) {
    super(
      gateway,
      'security',
      'Security Agent',
      '注入漏洞、权限绕过、敏感信息泄露、反序列化和输入校验缺失',
      toolRegistry
    );
  }
}
