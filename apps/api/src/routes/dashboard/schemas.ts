import { z } from "zod";

// docs/specs/personal-dashboard.md §I — response contract for GET /dashboard/my-view

export const WorkflowStateCountSchema = z.object({
  stateId: z.string(),
  stateName: z.string(),
  count: z.number().int().nonnegative(),
});

export const WorkflowBreakdownSchema = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  counts: z.array(WorkflowStateCountSchema),
  total: z.number().int().nonnegative(),
});

// entityTypeId/workflowId are included (alongside the display-friendly *Name
// fields) so the admin-ui drill-down (R6) can build a `/records/:typeSlug/:id`
// or `/workflows/:slug/records` link without a second round-trip.
export const DueDateItemSchema = z.object({
  entityId: z.string(),
  entityTypeId: z.string(),
  entityTypeName: z.string(),
  workflowId: z.string().nullable(),
  title: z.string(),
  dueDate: z.string(),
  isOverdue: z.boolean(),
});

export const SlaRiskItemSchema = z.object({
  entityId: z.string(),
  entityTypeId: z.string(),
  entityTypeName: z.string(),
  title: z.string(),
  workflowId: z.string(),
  stateName: z.string(),
  hoursOver: z.number(),
});

// R7 — capped list + a separate qualifying count so the UI can render "N more".
// `unavailable: true` (dueDates/slaRisk only, never workflows — R8) signals that
// section's computation failed; the rest of the response is still returned.
export const DueDatesSectionSchema = z.object({
  items: z.array(DueDateItemSchema),
  totalQualifying: z.number().int().nonnegative(),
  unavailable: z.boolean().optional(),
});

export const SlaRiskSectionSchema = z.object({
  items: z.array(SlaRiskItemSchema),
  totalQualifying: z.number().int().nonnegative(),
  unavailable: z.boolean().optional(),
});

// v1.2 — every scoped ticket, irrespective of workflow, whether or not it has
// a due_date set (unlike DueDateItemSchema, which only covers the subset that
// does). Sorted overdue-first (worst first), then dated-soonest-first, then
// undated tickets last. This is the single source for a genuine flat
// "my tickets" list — dueDates/slaRisk above remain their own sections for
// KPI counts and the SLA table; this does not replace them.
export const TicketSummarySchema = z.object({
  entityId: z.string(),
  entityTypeId: z.string(),
  entityTypeName: z.string(),
  workflowId: z.string().nullable(),
  workflowName: z.string().nullable(),
  stateName: z.string(),
  title: z.string(),
  dueDate: z.string().nullable(),
  isOverdue: z.boolean(),
});

export const TicketsSectionSchema = z.object({
  items: z.array(TicketSummarySchema),
  totalQualifying: z.number().int().nonnegative(),
  unavailable: z.boolean().optional(),
});

// v1.1 (R10) — workflows the caller administers (workflows.createdBy === userId
// or userId is in workflows.assignedTo). No unavailable flag — a query failure
// here just yields an empty list (see my-view.ts's try/catch).
export const AdminWorkflowSchema = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  entityTypeId: z.string(),
});

// v1.1 (R11) — the caller's saved views across every entity type, not scoped
// to one entityTypeId like GET /saved-views.
export const SavedViewSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  entityTypeId: z.string(),
  entityTypeName: z.string(),
});

// v1.1 (R12) — pending access_requests on workflows the caller administers.
// Authorization reuses isWorkflowAdmin verbatim (§V) — no parallel check.
export const PendingApprovalItemSchema = z.object({
  requestId: z.string(),
  entityId: z.string(),
  entityTypeId: z.string(),
  entityTypeName: z.string(),
  title: z.string(),
  requesterId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  requestedLevel: z.enum(["read_only", "read_comment", "read_write"]),
  createdAt: z.string(),
});

export const PendingApprovalsSectionSchema = z.object({
  items: z.array(PendingApprovalItemSchema),
  totalQualifying: z.number().int().nonnegative(),
  unavailable: z.boolean().optional(),
});

export const MyViewResponseSchema = z.object({
  data: z.object({
    workflows: z.array(WorkflowBreakdownSchema),
    tickets: TicketsSectionSchema,
    dueDates: DueDatesSectionSchema,
    slaRisk: SlaRiskSectionSchema,
    adminWorkflows: z.array(AdminWorkflowSchema),
    savedViews: z.array(SavedViewSummarySchema),
    pendingApprovals: PendingApprovalsSectionSchema,
  }),
});

export type MyViewResponse = z.infer<typeof MyViewResponseSchema>;
