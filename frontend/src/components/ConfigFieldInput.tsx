
import type { ConfigFieldDto } from '@/services/configService';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Lock } from 'lucide-react';

interface ConfigFieldInputProps {
  field: ConfigFieldDto;
  value: any;
  onChange: (value: any) => void;
}

export function ConfigFieldInput({ field, value, onChange }: ConfigFieldInputProps) {
  const isReadonly = !!field.readonly;

  const renderInput = () => {
    const baseInputClasses = "bg-zinc-900/50 border-white/10 focus-visible:ring-primary focus-visible:border-primary transition-all duration-200" + (isReadonly ? " opacity-50 cursor-not-allowed" : "");
    switch (field.type) {
      case 'boolean':
        return (
          <Switch
            checked={Boolean(value)}
            onCheckedChange={onChange}
            disabled={isReadonly}
            className={`data-[state=checked]:bg-primary ${isReadonly ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
        );
      case 'enum':
        return (
          <Select
            value={value !== undefined && value !== null ? String(value) : ''}
            onValueChange={onChange}
            disabled={isReadonly}
          >
            <SelectTrigger className={`w-full ${baseInputClasses}`}>
              <SelectValue placeholder="请选择..." />
            </SelectTrigger>
            <SelectContent className="bg-zinc-950 border-white/10">
              {field.enumValues?.map((val) => (
                <SelectItem key={val} value={val} className="focus:bg-zinc-900 focus:text-primary">
                  {val}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'text':
        return (
          <Textarea
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.sensitive && field.hasValue ? '••••••••' : ''}
            className={`min-h-[100px] ${baseInputClasses}`}
            disabled={isReadonly}
          />
        );
      case 'number':
        return (
          <Input
            type="number"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.sensitive && field.hasValue ? '••••••••' : ''}
            min={field.min}
            max={field.max}
            disabled={isReadonly}
            className={baseInputClasses}
          />
        );
      case 'string':
      case 'url':
      default:
        return (
          <Input
            type={field.type === 'url' ? 'url' : 'text'}
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.sensitive && field.hasValue ? '••••••••' : ''}
            disabled={isReadonly}
            className={baseInputClasses}
          />
        );
    }
  };

  const getSourceBadge = () => {
    switch (field.source) {
      case 'override':
        return <Badge className="ml-2 bg-primary/20 text-primary border-primary/30 tech-glow hover:bg-primary/30 transition-colors">覆盖值</Badge>;
      case 'env':
        return <Badge variant="secondary" className="ml-2 bg-amber-500/20 text-amber-500 border-amber-500/30 hover:bg-amber-500/30">环境变量</Badge>;
      case 'default':
      default:
        return <Badge variant="outline" className="ml-2 border-zinc-600 text-zinc-400">默认值</Badge>;
    }
  };

  return (
    <div className="flex flex-col py-5 px-1 gap-3 hover:bg-zinc-900/30 transition-colors rounded-lg">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="flex flex-col space-y-1.5 flex-1">
          <div className="flex items-center">
            <Label className="text-base font-semibold text-zinc-100">{field.label || field.envKey}</Label>
            {getSourceBadge()}
          </div>
          <div className="text-sm text-zinc-400 leading-relaxed">
            {field.description}
          </div>
          <div className="pt-1">
            <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 inline-flex items-center">
              $ {field.envKey}
            </span>
          </div>
        </div>

        <div className="flex-1 w-full max-w-xl flex flex-col gap-2">
          {renderInput()}
          
          {isReadonly && (
            <div className="text-xs text-zinc-500 flex items-center gap-1.5 pt-1">
              <Lock className="w-3.5 h-3.5" />
              只读配置，请通过环境变量文件修改
            </div>
          )}

          {!isReadonly && field.readonlyWarning && (
            <div className="text-xs text-amber-500 flex items-center gap-1.5 pt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              {field.readonlyWarning}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
