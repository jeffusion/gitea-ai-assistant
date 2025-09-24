"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { Repository } from "@/services/repositoryService"
import { Badge } from "@/components/ui/badge"
import { WebhookToggleButton } from "@/components/WebhookToggleButton"

export const columns: ColumnDef<Repository>[] = [
  {
    accessorKey: "name",
    header: "仓库名称",
    cell: ({ row }) => <div className="font-medium">{row.getValue("name")}</div>,
  },
  {
    accessorKey: "webhook_status",
    header: "Webhook 状态",
    cell: ({ row }) => {
      const status = row.getValue("webhook_status") as Repository["webhook_status"]
      const isActive = status === 'active'
      return (
        <Badge variant={isActive ? "default" : "outline"}>
          {isActive ? '已启用' : '未启用'}
        </Badge>
      )
    },
  },
  {
    id: "actions",
    header: () => <div className="text-right">操作</div>,
    cell: ({ row }) => {
      const repo = row.original
      return (
        <div className="text-right">
          <WebhookToggleButton
            repoName={repo.name}
            status={repo.webhook_status}
            hookId={repo.hook_id}
          />
        </div>
      )
    },
  },
]
