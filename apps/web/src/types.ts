export type DashboardResponse = {
  reservationSummary: {
    total: number;
    pendingApproval: number;
    active: number;
    delayed: number;
    completedToday: number;
  };
  recentAlerts: Array<{
    reservationId: string;
    previousStatus: string;
    newStatus: string;
    createdAt: string;
    reason?: string;
  }>;
  generatedAt: string;
};

export type DeliveryRow = {
  id: string;
  reservationId: string;
  channel: string;
  status: string;
  errorCategory?: string;
  errorMessage?: string;
  attemptNumber: number;
  queueJobId: string;
  queueJobName: string;
  createdAt: string;
  sentAt?: string;
};

export type DeliveryResponse = {
  items: DeliveryRow[];
  total: number;
};

export type DeadLetterRetryResponse = {
  dryRun: boolean;
  selected: number;
  wouldEnqueue: number;
  enqueued: number;
  skippedPermanent: number;
  duplicateGroups: number;
};

export type EventArchiveRow = {
  id: string;
  reservationId?: string;
  eventType: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  title: string;
  detail: string;
  eventAt: string;
  triageStatus: "OPEN" | "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED";
  acknowledgedAt?: string;
  acknowledgedByUserId?: string;
  snoozedUntil?: string;
  assignedUserId?: string;
};

export type EventArchiveResponse = {
  items: EventArchiveRow[];
  total?: number;
  nextCursorId?: string;
};

export type EventTriageResponse = {
  action: "acknowledge" | "snooze" | "assign" | "resolve";
  matched: number;
  updated: number;
};

export type OperationsMetricsResponse = {
  generatedAt: string;
  eventArchiveQueryCount: number;
  eventArchiveQueryLatencyMsAvg: number;
  triageActionCount: number;
  triageActionLatencyMsAvg: number;
  triageFailureCount: number;
  triageActionBreakdown: {
    acknowledge: number;
    snooze: number;
    assign: number;
    resolve: number;
  };
};
