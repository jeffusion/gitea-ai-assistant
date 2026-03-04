
import { ProviderList } from './ProviderList';
import { RoleAssignment } from './RoleAssignment';

export function LLMProviders() {
  return (
    <div className="min-h-screen pb-12">
      <div className="max-w-5xl mx-auto space-y-8 mt-6 px-4 md:px-6 lg:px-8">
        <ProviderList />
        <RoleAssignment />
      </div>
    </div>
  );
}
