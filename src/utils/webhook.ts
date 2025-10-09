import { configService } from '@/services/configService';

/**
 * 生成Webhook URL
 * @param fallbackOrigin 请求的origin作为兜底
 * @returns 完整的webhook URL
 */
export async function generateWebhookUrl(fallbackOrigin?: string): Promise<string> {
  // 优先使用配置服务中的BASE_URL
  const baseUrl = await configService.getConfig('BASE_URL');
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/webhook/gitea`;
  }

  // 兜底使用请求的origin
  if (fallbackOrigin) {
    console.warn('⚠️ 未配置BASE_URL，使用请求origin作为webhook URL。生产环境建议配置BASE_URL环境变量');
    return `${fallbackOrigin}/webhook/gitea`;
  }

  throw new Error('无法生成webhook URL：未配置BASE_URL且无法获取请求origin');
}

/**
 * 验证Webhook URL是否有效
 * @param url webhook URL
 * @returns 是否有效
 */
export function validateWebhookUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    // 检查是否为localhost（在生产环境中不应该使用）
    if (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') {
      console.warn('⚠️ Webhook URL使用localhost，外部Git服务器可能无法访问');
    }
    return true;
  } catch {
    return false;
  }
}