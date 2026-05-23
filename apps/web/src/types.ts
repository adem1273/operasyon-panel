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
