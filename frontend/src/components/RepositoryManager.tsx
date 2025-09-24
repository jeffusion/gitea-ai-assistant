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
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]"><Skeleton className="h-5 w-24" /></TableHead>
            <TableHead className="w-[30%]"><Skeleton className="h-5 w-24" /></TableHead>
            <TableHead className="w-[30%] text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 10 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-5 w-3/4" /></TableCell>
              <TableCell><Skeleton className="h-6 w-20" /></TableCell>
              <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
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
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-semibold text-lg md:text-2xl">仓库 Webhook 管理</h1>
        <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
                type="search"
                placeholder="搜索仓库..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 sm:w-[300px] md:w-[200px] lg:w-[300px]"
            />
        </div>
      </div>

      {isLoading ? (
        <DataTableSkeleton />
      ) : isError ? (
        <div className="p-4">
          {/* The original Alert component was removed, so this will now just show the error message */}
          <p className="text-red-500">加载仓库列表失败: {error.message}</p>
        </div>
      ) : (
        <>
          <DataTable columns={columns} data={repos} />
          {totalPages > 1 && (
            <div className="flex items-center justify-between w-full mt-4 space-x-4">
              <div className="text-sm text-muted-foreground flex-shrink-0">
                第 {page} 页 / 共 {totalPages} 页 (共 {totalCount} 个仓库)
              </div>
              <Pagination className="flex-shrink-0 justify-end w-auto">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(p => Math.max(1, p - 1));
                      }}
                      className={page <= 1 ? "pointer-events-none opacity-50" : ""}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(p => Math.min(totalPages, p + 1));
                      }}
                      className={page >= totalPages ? "pointer-events-none opacity-50" : ""}
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
