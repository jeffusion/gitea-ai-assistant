"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { Repository } from "@/services/repositoryService"
import { WebhookToggleButton } from "@/components/WebhookToggleButton"

export const columns: ColumnDef<Repository>[] = [
  {
    accessorKey: "name",
    header: "仓库名称",
    cell: ({ row }) => <div className="font-medium text-foreground text-sm">{row.getValue("name")}</div>,
  },
  {
    accessorKey: "webhook_status",
    header: "Webhook 状态",
    cell: ({ row }) => {
      const status = row.getValue("webhook_status") as Repository["webhook_status"]
      const isActive = status === 'active'
      return (
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${isActive ? 'bg-success/10 text-success border-success/30' : 'bg-transparent text-muted-foreground border-border theme-border-soft'}`}>
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse theme-glow-success"></span>}
          {isActive ? '已启用' : '未启用'}
        </div>
      )
    },
  },
  {
    id: "actions",
    header: () => <div className="text-right text-muted-foreground">操作</div>,
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
