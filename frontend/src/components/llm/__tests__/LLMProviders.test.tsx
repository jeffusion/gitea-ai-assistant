import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LLMProviders } from '../LLMProviders';

vi.mock('../ProviderList', () => ({
  ProviderList: () => <div>提供商区域</div>,
}));

vi.mock('../RoleAssignment', () => ({
  RoleAssignment: () => <div>角色区域</div>,
}));

describe('LLMProviders', () => {
  it('renders providers and roles sections', () => {
    render(<LLMProviders />);

    expect(screen.getByText('提供商区域')).toBeInTheDocument();
    expect(screen.getByText('角色区域')).toBeInTheDocument();
  });
});
