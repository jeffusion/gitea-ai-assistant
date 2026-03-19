import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const COLOR_PALETTE_STORAGE_KEY = 'ui-color-palette';

export const COLOR_PALETTES = ['cobalt', 'zinc', 'nord', 'tokyo-night'] as const;

export type ColorPalette = (typeof COLOR_PALETTES)[number];

type ColorPaletteContextValue = {
  palette: ColorPalette;
  setPalette: (palette: ColorPalette) => void;
};

const ColorPaletteContext = createContext<ColorPaletteContextValue | null>(null);

export const isColorPalette = (value: string): value is ColorPalette =>
  COLOR_PALETTES.includes(value as ColorPalette);

const resolveInitialPalette = (): ColorPalette => {
  if (typeof window === 'undefined') {
    return 'cobalt';
  }

  const stored = window.localStorage.getItem(COLOR_PALETTE_STORAGE_KEY);
  if (stored && isColorPalette(stored)) {
    return stored;
  }

  return 'cobalt';
};

export const ColorPaletteProvider = ({ children }: { children: ReactNode }) => {
  const [palette, setPalette] = useState<ColorPalette>(resolveInitialPalette);

  useEffect(() => {
    window.document.documentElement.setAttribute('data-palette', palette);
    window.localStorage.setItem(COLOR_PALETTE_STORAGE_KEY, palette);
  }, [palette]);

  const value = useMemo<ColorPaletteContextValue>(
    () => ({
      palette,
      setPalette,
    }),
    [palette]
  );

  return <ColorPaletteContext.Provider value={value}>{children}</ColorPaletteContext.Provider>;
};

export const useColorPalette = () => {
  const context = useContext(ColorPaletteContext);
  if (!context) {
    throw new Error('useColorPalette must be used within ColorPaletteProvider');
  }

  return context;
};
