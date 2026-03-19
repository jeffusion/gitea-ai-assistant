
import React from 'react';
import type { ConfigGroupDto, ConfigFieldDto } from '@/services/configService';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfigFieldInput } from './ConfigFieldInput';
import {
  RotateCcw, Link, Bot, Bell, Settings, Shield, FileCheck, Brain,
  type LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  link: Link,
  bot: Bot,
  bell: Bell,
  settings: Settings,
  shield: Shield,
  'file-check': FileCheck,
  brain: Brain,
};

interface ConfigGroupCardProps {
  group: ConfigGroupDto;
  localConfig: Record<string, any>;
  onFieldChange: (envKey: string, value: any) => void;
  onReset: (keys: string[]) => void;
  isResetting: boolean;
  /** Optional custom renderer for individual fields. Return `undefined` to use default ConfigFieldInput. */
  renderField?: (field: ConfigFieldDto, value: any, onChange: (val: any) => void) => React.ReactNode | undefined;
}

export function ConfigGroupCard({
  group,
  localConfig,
  onFieldChange,
  onReset,
  isResetting,
  renderField,
}: ConfigGroupCardProps) {
  const hasOverride = group.fields.some((f) => f.source === 'db');

  const handleReset = () => {
    // Only reset fields that have been stored in DB
    const keysToReset = group.fields
      .filter((f) => f.source === 'db')
      .map((f) => f.envKey);

    if (keysToReset.length > 0) {
      onReset(keysToReset);
    }
  };

  return (
    <Card className="mb-8 gap-0 py-0 theme-card-shell theme-interactive-elevate group">
      <CardHeader className="theme-card-header flex flex-row items-start justify-between pb-4 space-y-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 tech-glow group-hover:bg-accent transition-all duration-300">
            {(() => {
              const Icon = ICON_MAP[group.icon];
              return Icon ? <Icon className="h-5 w-5 text-primary" /> : <span className="text-primary">{group.icon}</span>;
            })()}
          </div>
          <div className="space-y-1">
            <CardTitle className="text-xl font-bold text-foreground tracking-tight">
              {group.label}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {group.description}
            </CardDescription>
          </div>
        </div>
        {hasOverride && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={isResetting}
            className="theme-interactive-elevate border-danger/30 text-danger hover:bg-danger/10 hover:text-danger hover:border-danger/50 transition-colors"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            重置组配置
          </Button>
        )}
      </CardHeader>
      <CardContent className="theme-card-content divide-y divide-border/50">
        {group.fields.map((field) => {
          const custom = renderField?.(field, localConfig[field.envKey], (val) => onFieldChange(field.envKey, val));
          if (custom !== undefined) return <React.Fragment key={field.envKey}>{custom}</React.Fragment>;
          return (
            <ConfigFieldInput
              key={field.envKey}
              field={field}
              value={localConfig[field.envKey]}
              onChange={(val) => onFieldChange(field.envKey, val)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
