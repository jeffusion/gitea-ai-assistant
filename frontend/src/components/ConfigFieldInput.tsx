
import type { ConfigFieldDto } from '@/services/configService';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

interface ConfigFieldInputProps {
  field: ConfigFieldDto;
  value: any;
  onChange: (value: any) => void;
}

export function ConfigFieldInput({ field, value, onChange }: ConfigFieldInputProps) {
  const renderInput = () => {
    const baseInputClasses = "bg-muted/50 border-border focus-visible:ring-primary focus-visible:border-primary transition-all duration-200";
    switch (field.type) {
      case 'boolean':
        return (
          <Switch
            checked={Boolean(value)}
            onCheckedChange={onChange}
            className="data-[state=checked]:bg-primary"
          />
        );
      case 'enum':
        return (
          <Select
            value={value !== undefined && value !== null ? String(value) : ''}
            onValueChange={onChange}
          >
            <SelectTrigger className={`w-full ${baseInputClasses}`}>
              <SelectValue placeholder="请选择..." />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              {field.enumValues?.map((val) => (
                <SelectItem key={val} value={val} className="focus:bg-accent focus:text-primary">
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
            className={baseInputClasses}
          />
        );
    }
  };

  const getSourceBadge = () => {
    switch (field.source) {
      case 'db':
        return <Badge className="ml-2 bg-primary/20 text-primary border-primary/30 tech-glow hover:bg-accent hover:text-foreground hover:border-border/70 transition-colors">已配置</Badge>;
      case 'default':
      default:
        return <Badge variant="outline" className="ml-2 border-border text-muted-foreground">默认值</Badge>;
    }
  };

  return (
    <div className="flex flex-col py-5 px-1 gap-3 hover:bg-accent/40 transition-colors rounded-lg">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="flex flex-col space-y-1.5 flex-1">
          <div className="flex items-center">
            <Label className="text-base font-semibold text-foreground">{field.label || field.envKey}</Label>
            {getSourceBadge()}
          </div>
          <div className="text-sm text-muted-foreground leading-relaxed">
            {field.description}
          </div>
          <div className="pt-1">
            <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 inline-flex items-center">
              {field.envKey}
            </span>
          </div>
        </div>

        <div className="flex-1 w-full max-w-xl flex flex-col gap-2">
          {renderInput()}
        </div>
      </div>
    </div>
  );
}
