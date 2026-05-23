# VIPFlow - Technical Specification (v1.0)

## 1. Product Scope

VIPFlow is an enterprise AI-powered multi-tenant SaaS platform for VIP transportation, chauffeur services, airport transfers, and operational fleet management.

### 1.1 Primary Objectives

- Reduce manual workload and operational mistakes.
- Operate 100-300+ daily reservations per tenant with high concurrency.
- Enable AI-assisted operations with strict human approval gates.
- Provide real-time visibility across reservations, drivers, vehicles, and flights.
- Optimize profitability through assignment intelligence, routing, and financial analytics.

### 1.2 Core Non-Functional Targets

- Strict tenant isolation.
- Production-ready and auditable operations.
- Horizontal scalability path (microservice-ready modular monolith).
- Low-latency realtime updates.
- High reliability with graceful degradation and fallback providers.

## 2. Architecture Overview

### 2.1 Architectural Style

- Modular Monolith with explicit domain boundaries.
- Event-driven workflows between modules.
- Queue-backed asynchronous processing for CPU/IO heavy tasks.
- Realtime channel for operational synchronization.

### 2.2 Technology Baseline

- Backend: NestJS + TypeScript.
- Database: PostgreSQL 16 with RLS.
- ORM: Prisma.
- Cache and queues: Redis + BullMQ.
- Realtime: Socket.IO + Redis adapter.
- Frontend: React 19 + Vite + TailwindCSS + shadcn/ui + TanStack Query.
- Storage: Cloudflare R2 (default), S3/MinIO compatible.
- Observability: OpenTelemetry, Prometheus, Grafana, Sentry.

### 2.3 Deployment Model

- White-label SaaS.
- Shared database, tenant-aware application layer.
- Custom domain and branding per tenant.
- Plan-based feature and usage limits.

## 3. Multi-Tenancy and Security

### 3.1 Tenant Isolation Strategy

- Every tenant is an independent agency.
- Every tenant-aware table includes tenant_id.
- Tenant context is required in:
	- API layer
	- Database session
	- Queue jobs
	- WebSocket events
	- Storage paths
	- Analytics pipeline
	- AI workflows

RLS policy pattern:

```sql
USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
```

Super admin bypass is allowed only via explicit elevated database role and audited actions.

### 3.2 RBAC

Roles:

- SUPER_ADMIN
- TENANT_ADMIN
- OPERATOR
- DRIVER
- ACCOUNTANT

Authorization model:

- Role + permission matrix in database.
- Endpoint and action guards in backend.
- Tenant-aware permission checks for every data mutation.

### 3.3 Security Controls

- JWT access tokens + refresh token rotation.
- Device and IP tracking.
- Session revocation support.
- MFA-ready architecture.
- Rate limiting and brute-force protection.
- CSRF/XSS/SQL injection hardening.
- Signed URL based secure file access.
- Authenticated WebSocket connections.

## 4. Domain Modules

### 4.1 Auth Module

- Login, refresh, revoke, session management.
- Device/IP metadata tracking.
- Future MFA extension points.

### 4.2 Tenant Module

- Tenant lifecycle, branding, limits, feature flags.
- Tenant context resolver middleware.

### 4.3 Reservation Module

- Reservation CRUD and state machine.
- AI-assisted intake from multiple channels.
- Approval queue with operator correction.

Reservation states:

- PENDING_APPROVAL
- CONFIRMED
- DRIVER_ASSIGNED
- DRIVER_ACCEPTED
- DRIVER_EN_ROUTE
- CUSTOMER_PICKED_UP
- IN_PROGRESS
- COMPLETED
- CANCELLED
- NO_SHOW
- DELAYED
- FAILED

### 4.4 AI Module

- OCR and multimodal extraction.
- Confidence scoring.
- Hallucination prevention and schema validation.
- Provider fallback orchestration.
- Human approval workflow integration.

Providers:

- GPT-4o Vision
- Claude 3.5 Sonnet
- Google Vision API
- Tesseract OCR

### 4.5 Operations Module

- Dispatch board and live operations center.
- Conflict detection (driver/vehicle overlap, impossible ETA).
- Smart alert generation and severity management.

### 4.6 Fleet Module

- Driver and vehicle lifecycle.
- Assignment engine with suitability scoring.
- Live location and telemetry history.

### 4.7 Finance Module

- Revenue, expenses, invoice, payment, commission logic.
- Multi-currency and tax-ready calculations.
- Exportable financial reporting.

### 4.8 Notification Module

- Push (FCM), WhatsApp Business API, in-app notifications.
- Tenant-aware templates and localization.

### 4.9 Analytics Module

- Fleet and driver performance metrics.
- Density prediction and operational forecasting.
- KPI dashboards by role and tenant.

### 4.10 Billing Module

- Subscription plans and tenant usage metering.
- AI usage accounting.
- Stripe integration and invoice generation.

## 5. Data Architecture

### 5.1 Core Tables

- tenants
- agencies
- users
- roles
- permissions
- reservations
- reservation_status_logs
- ai_approval_queue
- drivers
- vehicles
- assignments
- expenses
- invoices
- payments
- notifications
- smart_alerts
- audit_logs
- flight_tracking_logs
- telemetry_history
- billing_subscriptions
- messages

### 5.2 Data Modeling Rules

- tenant_id on all tenant-aware entities.
- Soft delete for reversible operations.
- Immutable audit entries for critical actions.
- Composite indexes on tenant_id + operational lookup keys.
- Idempotency keys for external callbacks and async handlers.

### 5.3 Audit Logging

Track at minimum:

- user_id
- tenant_id
- action_type
- old_value
- new_value
- timestamp
- ip_address
- device_info
- module_name
- entity_type
- entity_id

Critical audited modules:

- Reservation changes
- Assignment changes
- Financial changes
- Driver and vehicle changes
- Pricing and invoice changes
- Permission and user management changes

## 6. Event and Queue Design

### 6.1 Domain Events

- reservation_created
- reservation_confirmed
- driver_assigned
- transfer_started
- transfer_completed
- payment_received
- invoice_generated
- delay_detected

### 6.2 Queue Topology

BullMQ queues:

- OCR processing
- AI extraction
- WhatsApp jobs
- Notification dispatching
- Flight checks
- Analytics processing
- Report generation
- Pricing calculations

Queue requirements:

- Tenant context propagation in every job payload.
- Retry with exponential backoff.
- Dead-letter handling and alerting.
- Idempotent processors.

## 7. Realtime and Tracking

### 7.1 Realtime Requirements

- Live dashboard synchronization.
- Assignment and status push updates.
- Driver location updates.
- Delay and conflict alerts.

### 7.2 Vehicle and Route Intelligence

- Live GPS tracking.
- ETA recalculation with traffic context.
- Dynamic rerouting and multi-stop optimization.
- Airport congestion overlays and operational heatmaps.

## 8. AI-Assisted Operations

### 8.1 AI Approval Queue Rules

- No reservation becomes operationally active before operator approval.
- Confidence < 85% forces manual review.
- Every correction is persisted and auditable.

### 8.2 Assignment Intelligence

Scoring factors:

- Distance and traffic-adjusted ETA
- Driver rating and punctuality
- Shift duration and overtime risk
- Vehicle compatibility and VIP suitability
- Multi-job efficiency and fuel impact

Outputs:

- Top 3 suggestions
- Suitability scores
- Risk analysis
- Human-readable rationale

### 8.3 Predictive Assistant

Continuously evaluates:

- Traffic patterns
- Reservation timing risk
- Driver and vehicle availability
- Airport density
- Historical delay patterns

Provides proactive warnings and recommended actions before disruption.

## 9. External Integrations

- Flight APIs: FlightAware, AviationStack.
- Maps: Google Maps API, Leaflet/OpenStreetMap.
- Messaging: Official WhatsApp Business API.
- Push: Firebase Cloud Messaging.
- Storage: Cloudflare R2, AWS S3, MinIO.
- Billing: Stripe.

## 10. Frontend and UX Scope

Core pages:

- Live Operations Center
- Approval Queue
- Driver Application (PWA/mobile responsive)
- Reservation Management
- Fleet Dashboard
- Finance Dashboard
- Analytics Dashboard

Driver app capabilities:

- Accept/reject assignment
- Status updates
- Navigation launch (Google Maps/Waze)
- Receipt upload and expense logging
- Offline mode and push notifications

## 11. Observability and Reliability

### 11.1 Monitoring

Track:

- API latency and error rates
- Queue lag and worker health
- WebSocket throughput
- Database performance
- AI provider usage and failure rates

### 11.2 Recovery and Backups

- Automatic backups
- Point-in-time recovery
- Replication strategy
- Disaster recovery runbooks

## 12. Implementation Roadmap

### Phase 1 - Foundation (Weeks 1-4)

- Project bootstrap, module boundaries, auth, tenant middleware.
- PostgreSQL schema with RLS baseline.
- RBAC and audit logging core.
- Reservation basic CRUD and status pipeline.

### Phase 2 - Core Operations (Weeks 5-8)

- Driver/vehicle management and assignment workflows.
- Live operations dashboard and WebSocket channels.
- Conflict detection and smart alerts.
- Basic finance records (expenses, payments, invoices).

### Phase 3 - AI and Automation (Weeks 9-12)

- OCR + AI extraction pipeline and approval queue.
- WhatsApp and push notifications.
- Flight tracking integration.
- Assignment scoring and recommendation engine.

### Phase 4 - Enterprise Hardening (Weeks 13-16)

- Billing/subscription module.
- Advanced analytics and predictive models.
- White-label capabilities and localization.
- Performance tuning, security hardening, DR drills.

## 13. Success Metrics

- Manual dispatch workload reduced by >= 40%.
- Reservation processing error rate reduced by >= 60%.
- On-time pickup rate >= 95%.
- Assignment acceptance SLA < 2 minutes median.
- Critical incident detection lead time >= 15 minutes before failure.
- Per-tenant daily capacity sustained at 300+ reservations under peak load.

## 14. Engineering Acceptance Checklist

- Tenant isolation validated at API, DB, queue, socket, storage layers.
- RLS enabled on all tenant-aware tables.
- Critical actions are fully auditable and immutable.
- AI actions always pass through human approval when required.
- Realtime dashboard reflects status changes within target latency.
- Queue retries and dead-letter flows tested.
- Backup and restore scenario validated.
- Security baseline and penetration checks completed.
