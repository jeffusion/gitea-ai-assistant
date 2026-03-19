import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { fetchModelSuggestions } from '@/services/llmProviderService';
import type { ProviderType } from '@/services/llmProviderService';

interface ModelComboboxProps {
  providerType?: ProviderType;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function ModelCombobox({
  providerType,
  value,
  onChange,
  disabled,
  placeholder = '选择或输入模型...',
  className = '',
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync external value
  useEffect(() => {
    setInputValue(value);
  }, [value]);


  // Fetch dynamic model suggestions from backend (powered by models.dev)
  const { data: suggestions = {} } = useQuery({
    queryKey: ['llm-model-suggestions'],
    queryFn: fetchModelSuggestions,
    staleTime: 30 * 60 * 1000, // 30 min cache
  });

  // Build model list: suggestions > custom input
  const suggestionModels = providerType ? suggestions[providerType] || [] : [];

  type TaggedModel = { name: string; tag: '推荐' | '自定义' };

  const trimmedInput = inputValue.trim().toLowerCase();

  const buildTaggedList = (): TaggedModel[] => {
    const result: TaggedModel[] = [];
    const seen = new Set<string>();

    for (const m of suggestionModels) {
      if (!seen.has(m.toLowerCase()) && m.toLowerCase().includes(trimmedInput)) {
        result.push({ name: m, tag: '推荐' });
        seen.add(m.toLowerCase());
      }
    }

    // Custom input option when no exact match
    if (inputValue.trim().length > 0 && !seen.has(trimmedInput)) {
      result.push({ name: inputValue.trim(), tag: '自定义' });
    }

    return result;
  };

  const taggedModels = buildTaggedList();

  const TAG_STYLES: Record<string, string> = {
    '推荐': 'bg-info/15 text-info',
    '自定义': 'bg-warning/15 text-warning',
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    onChange(newValue);
    setIsOpen(true);
  };

  const handleSelect = (model: string) => {
    setInputValue(model);
    onChange(model);
    setIsOpen(false);
  };

  return (
    <div className={`relative ${className}`} ref={wrapperRef}>
      <div className="relative">
        <Input
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          className="bg-muted/50 border-border text-foreground w-full pr-10"
        />
      </div>

      {isOpen && !disabled && taggedModels.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl">
          <div className="py-1">
            {taggedModels.map((item, idx) => (
              <button
                type="button"
                key={`${item.tag}-${item.name}-${idx}`}
                className="w-full px-3 py-2 text-sm text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none cursor-pointer transition-colors flex items-center justify-between gap-2"
                onClick={() => handleSelect(item.name)}
              >
                <span className="truncate">{item.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${TAG_STYLES[item.tag]}`}>{item.tag}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
