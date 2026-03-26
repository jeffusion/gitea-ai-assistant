"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { Repository } from "@/services/repositoryService"
import { RepositoryConfigCell } from "@/components/RepositoryConfigCell"
import { WebhookToggleCell } from "@/components/WebhookToggleCell"

export const columns: ColumnDef<Repository>[] = [
  {
    accessorKey: "name",
    header: "仓库名称",
    cell: ({ row }) => (
      <div className="font-medium text-foreground text-sm">
        {row.getValue("name")}
      </div>
    ),
  },
  {
    accessorKey: "webhook_status",
    header: "Webhook",
    cell: ({ row }) => {
      const repo = row.original
      return <WebhookToggleCell repo={repo} />
    },
  },
  {
    id: "actions",
    header: () => <div className="text-right text-muted-foreground text-xs">提示词</div>,
    cell: ({ row }) => (
      <div className="text-right">
        <RepositoryConfigCell repo={row.original} />
      </div>
    ),
  },
]
