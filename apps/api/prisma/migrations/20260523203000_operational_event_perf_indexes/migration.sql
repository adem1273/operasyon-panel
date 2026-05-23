-- CreateIndex
CREATE INDEX "operational_events_tenantId_eventAt_id_idx" ON "operational_events"("tenantId", "eventAt", "id");

-- CreateIndex
CREATE INDEX "operational_events_tenantId_triageStatus_eventAt_id_idx" ON "operational_events"("tenantId", "triageStatus", "eventAt", "id");
