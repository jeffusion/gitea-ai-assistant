import { test, expect } from '@playwright/test';
import { installVisualApiMocks } from './fixtures/mockApi';
import { applyThemeAndAuth, installVisualNetworkGuards, stabilizeVisualState, waitForThemeReady, type VisualPalette } from './fixtures/stabilize';

type VisualCase = {
  name: string;
  path: string;
  authToken?: string;
  readySelectors: string[];
};

const protectedToken = 'visual-token';

const visualCases: VisualCase[] = [
  {
    name: 'login',
    path: '/',
    readySelectors: ['#password', 'button:has-text("AUTHORIZE")'],
  },
  {
    name: 'repos',
    path: '/repos',
    authToken: protectedToken,
    readySelectors: ['text=仓库名称', 'text=demo-repo-1'],
  },
  {
    name: 'config',
    path: '/config',
    authToken: protectedToken,
    readySelectors: ['button:has-text("保存配置")', 'text=Gitea 连接'],
  },
  {
    name: 'review-config',
    path: '/review-config',
    authToken: protectedToken,
    readySelectors: ['text=审查引擎', 'button:has-text("保存配置")'],
  },
];

const themes: Array<'light' | 'dark'> = ['light', 'dark'];
const palettes: VisualPalette[] = ['cobalt', 'zinc', 'nord', 'tokyo-night'];

for (const visualCase of visualCases) {
  for (const theme of themes) {
    for (const palette of palettes) {
      test(`${visualCase.name} ${theme} ${palette} baseline`, async ({ page }) => {
        await installVisualApiMocks(page);
        await installVisualNetworkGuards(page);
        await applyThemeAndAuth(page, theme, palette, visualCase.authToken);

        await page.goto(visualCase.path, { waitUntil: 'networkidle' });
        await waitForThemeReady(page, theme, palette);

        for (const selector of visualCase.readySelectors) {
          await page.locator(selector).first().waitFor({ state: 'visible' });
        }

        await stabilizeVisualState(page);

        const snapshotName =
          palette === 'cobalt'
            ? `${visualCase.name}-${theme}.png`
            : `${visualCase.name}-${theme}-${palette}.png`;

        await expect(page).toHaveScreenshot(snapshotName, {
          fullPage: true,
        });
      });
    }
  }
}
