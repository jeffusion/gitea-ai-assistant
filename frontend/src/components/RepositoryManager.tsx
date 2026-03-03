import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRepositories } from '@/services/repositoryService';
import type { PaginatedRepositories } from '@/services/repositoryService';
import { useDebounce } from '@/hooks/useDebounce';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';
import { Skeleton } from "@/components/ui/skeleton";
import { columns } from "./RepositoryTableColumns";
import { DataTable } from "./DataTable";
import { Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function DataTableSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 overflow-hidden glass-panel">
      <Table>
        <TableHeader className="bg-zinc-900 border-b border-border/50">
          <TableRow className="border-border/50">
            <TableHead className="w-[40%]"><Skeleton className="h-5 w-24 bg-zinc-800" /></TableHead>
            <TableHead className="w-[30%]"><Skeleton className="h-5 w-24 bg-zinc-800" /></TableHead>
            <TableHead className="w-[30%] text-right"><Skeleton className="h-5 w-16 ml-auto bg-zinc-800" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 10 }).map((_, i) => (
            <TableRow key={i} className="border-border/50">
              <TableCell><Skeleton className="h-5 w-3/4 bg-zinc-800/80" /></TableCell>
              <TableCell><Skeleton className="h-6 w-20 bg-zinc-800/80 rounded-full" /></TableCell>
              <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto bg-zinc-800/80" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}


export function RepositoryManager() {
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearchTerm = useDebounce(searchTerm, 500);

  const { data, isLoading, isError, error } = useQuery<PaginatedRepositories, Error>({
    queryKey: ['repositories', page, debouncedSearchTerm],
    queryFn: () => fetchRepositories(page, debouncedSearchTerm),
  });

  // 当搜索词变化时，重置到第一页
  useEffect(() => {
    if (debouncedSearchTerm) {
      setPage(1);
    }
  }, [debouncedSearchTerm]);

  const repos = data?.data || [];
  const totalCount = data?.totalCount || 0;
  const limit = data?.limit || 30;
  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div>
      <div className="flex justify-end mb-6">
        <div className="relative w-full md:w-auto">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <Input
                type="search"
                placeholder="搜索仓库..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 w-full sm:w-[300px] md:w-[250px] lg:w-[300px] bg-zinc-900/50 border-border/50 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:border-primary transition-all font-mono text-sm"
            />
        </div>
      </div>

      {isLoading ? (
        <DataTableSkeleton />
      ) : isError ? (
        <div className="p-6 rounded-xl border border-rose-500/20 bg-rose-500/5 glass-panel">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-rose-500/10 rounded-lg text-rose-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div className="space-y-1">
              <h3 className="font-mono text-sm font-medium text-rose-500">System Error_</h3>
              <p className="font-mono text-xs text-rose-400/80">加载仓库列表失败: {error.message}</p>
            </div>
          </div>
        </div>
      ) : (
        <>
          <DataTable columns={columns} data={repos} />
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between w-full mt-6 gap-4">
              <div className="font-mono text-xs text-zinc-400 flex-shrink-0 bg-zinc-900/50 px-3 py-1.5 rounded-md border border-white/5">
                第 <span className="text-zinc-200">{page}</span> 页 / 共 <span className="text-zinc-200">{totalPages}</span> 页 <span className="text-zinc-600 mx-1">|</span> 共 <span className="text-zinc-200">{totalCount}</span> 个仓库
              </div>
              <Pagination className="flex-shrink-0 w-auto mx-0">
                <PaginationContent className="gap-2">
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(p => Math.max(1, p - 1));
                      }}
                      className={`border border-border/50 hover:bg-zinc-800 hover:text-primary hover:border-primary/50 font-mono text-xs transition-colors ${page <= 1 ? "pointer-events-none opacity-30 bg-zinc-900/30" : "bg-zinc-900 text-zinc-400"}`}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(p => Math.min(totalPages, p + 1));
                      }}
                      className={`border border-border/50 hover:bg-zinc-800 hover:text-primary hover:border-primary/50 font-mono text-xs transition-colors ${page >= totalPages ? "pointer-events-none opacity-30 bg-zinc-900/30" : "bg-zinc-900 text-zinc-400"}`}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </>
      )}
    </div>
  );
}
