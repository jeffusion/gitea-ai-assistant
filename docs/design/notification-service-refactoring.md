# 通知服务抽象化重构方案

## 1. 概述

### 1.1 背景
当前项目中的通知功能仅支持飞书(Feishu/Lark)平台，代码高度耦合飞书特定的API实现。随着业务需求扩展，需要支持企业微信(WeCom)等其他通知渠道。

### 1.2 目标
- 抽象通用通知服务接口，支持多平台扩展
- 支持同时配置多个通知服务（如飞书+企业微信同时推送）
- 统一通知调用入口，避免平台耦合与重复发送
- 清晰的代码结构，便于后续添加新平台（如Slack、钉钉等）

### 1.3 非目标
- 不修改通知的业务触发逻辑
- 不改变现有的Gitea Webhook处理流程
- 不引入外部通知服务SDK依赖（保持轻量）

---

## 2. 现有架构分析

### 2.1 重构前实现（已下线）
```
src/
├── services/feishu.ts          # 飞书服务实现（156行）
├── controllers/review.ts       # 通知调用点
├── config/config-schema.ts     # 配置定义
└── config/config-manager.ts    # 配置管理
```

### 2.2 关键代码特征
- **强耦合**：`review.ts` 直接调用 `feishuService.sendXXXNotification()`
- **硬编码消息格式**：飞书特定的 `msg_type: 'text'` 结构
- **签名逻辑**：HMAC-SHA256(timestamp+"\n"+secret)
- **配置单一**：仅支持一组飞书配置

### 2.3 通知场景
| 场景 | 方法名 | 触发条件 |
|------|--------|----------|
| 工单创建 | `sendIssueCreatedNotification` | Issue opened + 有指派人 |
| 工单关闭 | `sendIssueClosedNotification` | Issue closed |
| 工单指派 | `sendIssueAssignedNotification` | Issue assigned |
| PR创建 | `sendPrCreatedNotification` | PR opened + 有审阅者 |
| PR指派 | `sendPrReviewerAssignedNotification` | PR review_requested |

---

## 3. 目标架构设计

### 3.1 架构模式
采用**策略模式(Strategy)** + **工厂模式(Factory)**：

```
┌─────────────────────────────────────────────────────────────┐
│                    Notification Service Layer               │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   INotification │  │   INotification │  │ INotification│ │
│  │    Service      │  │    Service      │  │   Service   │ │
│  │   (Interface)   │  │   (Interface)   │  │ (Interface) │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
│           │                    │                  │        │
│     ┌─────┴─────┐        ┌────┴────┐       ┌────┴────┐   │
│     │ Feishu    │        │ WeCom   │       │  Slack  │   │
│     │Service    │        │Service  │       │ Service │   │
│     └───────────┘        └─────────┘       └─────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │ NotificationFactory│
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ NotificationManager│ ← 统一入口，支持多服务
                    └───────────────────┘
```

### 3.2 核心接口设计

#### 3.2.1 类型定义
```typescript
// types.ts
export type NotificationProvider = 'feishu' | 'wecom' | 'slack' | 'dingtalk';

export interface NotificationContext {
  // PR相关
  prTitle?: string;
  prUrl?: string;
  prNumber?: number;
  
  // Issue相关
  issueTitle?: string;
  issueUrl?: string;
  issueNumber?: number;
  
  // 用户相关
  actor?: string;
  assignees?: string[];
  reviewers?: string[];
  creator?: string;
  
  // 仓库相关
  repository?: string;
  owner?: string;
  
  // 时间戳
  timestamp?: Date;
}

export interface NotificationMessage {
  type: 'text' | 'markdown';
  title?: string;
  content: string;
  atUsers?: string[];
  url?: string;
}
```

#### 3.2.2 服务接口
```typescript
// INotificationService
export interface INotificationService {
  readonly provider: NotificationProvider;
  
  isEnabled(): boolean;
  sendMessage(message: NotificationMessage): Promise<void>;
  
  // 场景特定方法
  sendIssueCreatedNotification(context: NotificationContext): Promise<void>;
  sendIssueClosedNotification(context: NotificationContext): Promise<void>;
  sendIssueAssignedNotification(context: NotificationContext): Promise<void>;
  sendPrCreatedNotification(context: NotificationContext): Promise<void>;
  sendPrReviewerAssignedNotification(context: NotificationContext): Promise<void>;
}
```

### 3.3 平台差异对照

| 特性 | 飞书(Feishu) | 企业微信(WeCom) | Slack |
|------|--------------|-----------------|-------|
| **Webhook格式** | `open.feishu.cn/open-apis/bot/v2/hook/{key}` | `qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}` | `hooks.slack.com/services/...` |
| **签名机制** | HMAC-SHA256(timestamp+"\n"+secret) | **无** | HMAC-SHA256(timestamp+":"+secret) |
| **@用户方式** | `<at user_id="xxx">` 或文本追加 | `mentioned_list: ["userid"]` 或手机号 | `<@user_id>` |
| **消息类型字段** | `msg_type` | `msgtype` | `type` |
| **内容字段** | `content.text` | `text.content` | `text` |
| **频率限制** | 100次/分钟 | 20条/分钟 | 1次/秒 |

---

## 4. 详细实现方案

### 4.1 目录结构
```
src/
├── services/
│   ├── notification/
│   │   ├── index.ts                          # 导出入口
│   │   ├── types.ts                          # 类型定义
│   │   ├── base-notification-service.ts      # 抽象基类
│   │   ├── notification-factory.ts           # 工厂
│   │   ├── notification-manager.ts           # 管理器
│   │   └── providers/
│   │       ├── feishu-notification-service.ts
│   │       └── wecom-notification-service.ts
│   └── notification-manager.ts               # 运行时通知管理器入口
```

### 4.2 基类实现

```typescript
// base-notification-service.ts
export abstract class BaseNotificationService implements INotificationService {
  abstract readonly provider: NotificationProvider;
  
  constructor(protected config: NotificationServiceConfig) {}
  
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.webhookUrl;
  }
  
  abstract sendMessage(message: NotificationMessage): Promise<void>;
  
  // 通用模板方法
  async sendIssueCreatedNotification(context: NotificationContext): Promise<void> {
    const message = this.buildIssueCreatedMessage(context);
    await this.sendMessage(message);
  }
  
  // 子类实现消息构建
  protected abstract buildIssueCreatedMessage(context: NotificationContext): NotificationMessage;
  // ... 其他方法类似
}
```

### 4.3 飞书实现要点

```typescript
// feishu-notification-service.ts
export class FeishuNotificationService extends BaseNotificationService {
  readonly provider = 'feishu' as const;
  
  async sendMessage(message: NotificationMessage): Promise<void> {
    const payload: any = {
      msg_type: 'text',
      content: {
        text: message.content,
      },
    };
    
    // 添加签名
    if (this.config.webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = this.generateSign(timestamp, this.config.webhookSecret);
    }
    
    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`Feishu notification failed: ${response.statusText}`);
    }
  }
  
  protected buildIssueCreatedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `📝 新工单已创建\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}`,
      atUsers: context.assignees,
    };
  }
  
  private generateSign(timestamp: string, secret: string): string {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', stringToSign);
    return hmac.digest('base64');
  }
}
```

### 4.4 企业微信实现要点

```typescript
// wecom-notification-service.ts
export class WeComNotificationService extends BaseNotificationService {
  readonly provider = 'wecom' as const;
  
  async sendMessage(message: NotificationMessage): Promise<void> {
    const payload: any = {
      msgtype: 'text',
      text: {
        content: message.content,
      },
    };
    
    // 企业微信使用 mentioned_list
    if (message.atUsers?.length) {
      payload.text.mentioned_list = message.atUsers.map(u => 
        u.toLowerCase() === 'all' ? '@all' : u
      );
    }
    
    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`WeCom notification failed: ${response.statusText}`);
    }
  }
  
  protected buildIssueCreatedMessage(context: NotificationContext): NotificationMessage {
    return {
      type: 'text',
      content: `📝 新工单已创建\n标题: ${context.issueTitle}\n链接: ${context.issueUrl}`,
      atUsers: context.assignees,
    };
  }
}
```

### 4.5 管理器实现

```typescript
// notification-manager.ts
export class NotificationManager {
  private services: INotificationService[] = [];
  
  constructor(configs: NotificationServiceConfig[]) {
    this.services = configs
      .filter(c => c.enabled && c.webhookUrl)
      .map(c => NotificationFactory.createService(c));
  }
  
  // 广播到所有服务
  async broadcast(
    operation: (service: INotificationService) => Promise<void>
  ): Promise<void> {
    const results = await Promise.allSettled(
      this.services.map(async service => {
        try {
          await operation(service);
        } catch (error) {
          logger.error(`${service.provider} notification failed:`, error);
          throw error; // 重新抛出以便Promise.allSettled捕获
        }
      })
    );
    
    // 记录失败统计
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(`${failures.length}/${this.services.length} notification services failed`);
    }
  }
  
  // 便捷方法
  async notifyIssueCreated(context: NotificationContext): Promise<void> {
    await this.broadcast(s => s.sendIssueCreatedNotification(context));
  }
  
  async notifyIssueClosed(context: NotificationContext): Promise<void> {
    await this.broadcast(s => s.sendIssueClosedNotification(context));
  }
  
  async notifyIssueAssigned(context: NotificationContext): Promise<void> {
    await this.broadcast(s => s.sendIssueAssignedNotification(context));
  }
  
  async notifyPrCreated(context: NotificationContext): Promise<void> {
    await this.broadcast(s => s.sendPrCreatedNotification(context));
  }
  
  async notifyPrReviewerAssigned(context: NotificationContext): Promise<void> {
    await this.broadcast(s => s.sendPrReviewerAssignedNotification(context));
  }
}
```

---

## 5. 配置改造

### 5.1 新增配置字段

```typescript
// config-schema.ts
export const CONFIG_FIELDS: ConfigFieldMeta[] = [
  // ... 保留原有 ...
  
  // 飞书配置（改造为可独立启用）
  {
    envKey: 'FEISHU_ENABLED',
    group: 'notification',
    label: '启用飞书通知',
    description: '是否启用飞书通知',
    type: 'boolean',
    sensitive: false,
    defaultValue: true,
  },
  {
    envKey: 'FEISHU_WEBHOOK_URL',
    group: 'notification',
    label: '飞书 Webhook 地址',
    description: '飞书机器人 Webhook URL',
    type: 'url',
    sensitive: false,
  },
  {
    envKey: 'FEISHU_WEBHOOK_SECRET',
    group: 'notification',
    label: '飞书 Webhook 密钥',
    description: '飞书 Webhook 签名密钥（可选）',
    type: 'string',
    sensitive: true,
  },
  
  // 企业微信配置（新增）
  {
    envKey: 'WECOM_ENABLED',
    group: 'notification',
    label: '启用企业微信通知',
    description: '是否启用企业微信通知',
    type: 'boolean',
    sensitive: false,
    defaultValue: false,
  },
  {
    envKey: 'WECOM_WEBHOOK_URL',
    group: 'notification',
    label: '企业微信 Webhook 地址',
    description: '企业微信机器人 Webhook URL',
    type: 'url',
    sensitive: false,
  },
];
```

### 5.2 配置组调整

```typescript
// 将 'feishu' 组改为 'notification' 组
export type ConfigGroup = 'gitea' | 'notification' | 'security' | 'review' | 'memory';

export const CONFIG_GROUPS: ConfigGroupMeta[] = [
  // ...
  {
    key: 'notification',
    label: '通知服务',
    description: '飞书、企业微信等通知渠道配置',
    icon: 'bell',
  },
  // ...
];
```

---

## 6. 调用层迁移

### 6.1 review.ts 改造

```typescript
import { getNotificationManager } from '../services/notification-manager';

// PR事件处理
async function handlePullRequestEvent(c: Context, body: any): Promise<Response> {
  // ... 原有逻辑 ...
  
  const context: NotificationContext = {
    prTitle: pullRequest.title,
    prUrl: pullRequest.html_url,
    prNumber: pullRequest.number,
    reviewers: reviewerUsernames,
    repository: repo.name,
    owner: repo.owner.login,
    actor: body.sender?.login,
  };
  
  const notificationManager = getNotificationManager();

  if (body.action === 'opened' && reviewerUsernames.length > 0) {
    await notificationManager.notifyPrCreated(context);
  }
  
  if (body.action === 'review_requested' && body.requested_reviewer) {
    context.assignees = [body.requested_reviewer.full_name || body.requested_reviewer.login];
    await notificationManager.notifyPrReviewerAssigned(context);
  }
  
  // ... 继续原有逻辑 ...
}

// Issue事件处理
async function handleIssueEvent(c: Context, body: any): Promise<Response> {
  // ...
  
  const context: NotificationContext = {
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    issueNumber: issue.number,
    creator: creatorUsername,
    assignees: assigneeUsernames,
    repository: repository.name,
    actor: body.sender?.login,
  };
  
  if (action === 'opened' && assigneeUsernames.length > 0) {
    await notificationManager.notifyIssueCreated(context);
  } else if (action === 'closed') {
    await notificationManager.notifyIssueClosed(context);
  } else if (action === 'assigned') {
    await notificationManager.notifyIssueAssigned(context);
  }
}
```

---

## 7. 落地决策（已执行）

### 7.1 旧飞书服务下线

- 已删除 `src/services/feishu.ts`，不再保留兼容层。
- `src/controllers/review.ts` 中所有通知发送路径已统一到 `NotificationManager`。
- 通过单一通知入口避免重复发送与配置路径分裂问题。

### 7.2 运行时配置生效策略

- 通知管理器按当前配置即时创建，不再使用长生命周期缓存。
- 后台保存通知配置后，可立即在后续 webhook 事件生效。

### 7.3 落地检查清单

- [x] 飞书与企业微信通过统一通知抽象发送
- [x] 旧飞书服务文件已下线
- [x] 控制器通知链路已去重
- [x] 前端新增独立“通知管理”菜单与页面

---

## 8. 实施计划

### 8.1 阶段划分

| 阶段 | 任务 | 文件 | 优先级 |
|------|------|------|--------|
| 1 | 核心抽象层 | `types.ts`, `base-notification-service.ts` | P0 |
| 2 | 工厂与管理器 | `notification-factory.ts`, `notification-manager.ts` | P0 |
| 3 | 飞书实现 | `providers/feishu-notification-service.ts` | P1 |
| 4 | 企业微信实现 | `providers/wecom-notification-service.ts` | P1 |
| 5 | 配置改造 | `config-schema.ts`, `config-manager.ts` | P1 |
| 6 | 调用层迁移 | `review.ts` | P1 |
| 7 | 前端通知管理页面 | `App.tsx`, `DashboardPage.tsx`, `NotificationConfigPage.tsx` | P1 |
| 8 | 测试验证 | `config-manager.test.ts` 等 | P0 |

### 8.2 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 签名算法变更 | 飞书通知失效 | 保持原有签名实现，单元测试覆盖 |
| 配置迁移失败 | 服务无法启动 | 添加配置验证和默认值回退 |
| 多服务并发失败 | 部分通知丢失 | Promise.allSettled 确保独立性 |

---

## 9. 测试策略

### 9.1 单元测试

```typescript
// __tests__/notification.test.ts
describe('NotificationService', () => {
  describe('FeishuNotificationService', () => {
    it('should generate correct signature', () => {
      // 测试签名算法
    });
    
    it('should format message correctly', () => {
      // 测试消息格式转换
    });
  });
  
  describe('WeComNotificationService', () => {
    it('should use mentioned_list for @users', () => {
      // 测试@用户格式
    });
  });
  
  describe('NotificationManager', () => {
    it('should broadcast to all enabled services', async () => {
      // 测试广播逻辑
    });
    
    it('should not fail if one service fails', async () => {
      // 测试容错
    });
  });
});
```

### 9.2 集成测试

- 配置真实飞书机器人测试消息发送
- 配置企业微信机器人测试消息发送
- 验证同时配置多个服务时的行为

---

## 10. 附录

### 10.1 飞书与企业微信API对比详情

#### 飞书消息格式
```json
{
  "msg_type": "text",
  "content": {
    "text": "Hello <at user_id=\"ou_xxx\">Tom</at>"
  }
}
```

#### 企业微信消息格式
```json
{
  "msgtype": "text",
  "text": {
    "content": "Hello World",
    "mentioned_list": ["wangqing", "@all"],
    "mentioned_mobile_list": ["13800001111"]
  }
}
```

### 10.2 扩展指南

添加新通知平台步骤：

1. 在 `types.ts` 添加新的 `NotificationProvider` 类型
2. 在 `providers/` 创建新的服务类，继承 `BaseNotificationService`
3. 在 `notification-factory.ts` 添加创建逻辑
4. 在 `config-schema.ts` 添加配置字段
5. 在 Admin Dashboard 添加UI配置项

---

**文档版本**: 1.0  
**创建日期**: 2026-03-24  
**作者**: Sisyphus  
**状态**: 已实施（持续验证中）
