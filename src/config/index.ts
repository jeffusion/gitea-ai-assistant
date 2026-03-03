import { configManager } from './config-manager';

type AppConfig = import('./config-manager').AppConfig;

const config = new Proxy({} as AppConfig, {
  get(_target, prop) {
    return configManager.getCurrent()[prop as keyof AppConfig];
  },
});

export { configManager };
export default config;
