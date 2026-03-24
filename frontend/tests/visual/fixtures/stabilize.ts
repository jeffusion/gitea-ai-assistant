import type { Page } from '@playwright/test';

export type VisualPalette = 'cobalt' | 'zinc' | 'nord' | 'tokyo-night';

const STABILIZE_STYLE = `
  *, *::before, *::after {
    transition-property: none !important;
    transition-duration: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

export async function stabilizeVisualState(page: Page) {
  await page.addStyleTag({ content: STABILIZE_STYLE });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.evaluate(async () => {
    if (document.fonts) {
      await document.fonts.ready;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

export async function installVisualNetworkGuards(page: Page) {
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '',
    });
  });

  await page.route('https://fonts.gstatic.com/**', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
}

export async function waitForThemeReady(page: Page, theme: 'light' | 'dark', palette: VisualPalette) {
  await page.waitForFunction(({ expectedTheme, expectedPalette }) => {
    const isDark = document.documentElement.classList.contains('dark');
    const currentPalette = document.documentElement.getAttribute('data-palette') ?? 'cobalt';
    const themeReady = expectedTheme === 'dark' ? isDark : !isDark;
    return themeReady && currentPalette === expectedPalette;
  }, { expectedTheme: theme, expectedPalette: palette });
}

export async function applyThemeAndAuth(
  page: Page,
  theme: 'light' | 'dark',
  palette: VisualPalette,
  authToken?: string
) {
  await page.addInitScript(
    ({ selectedTheme, selectedPalette, token }) => {
      localStorage.setItem('theme', selectedTheme);
      localStorage.setItem('ui-color-palette', selectedPalette);
      if (token) {
        localStorage.setItem('authToken', token);
      } else {
        localStorage.removeItem('authToken');
      }
    },
    { selectedTheme: theme, selectedPalette: palette, token: authToken }
  );
}
