# VIPFlow

Enterprise AI-powered multi-tenant SaaS platform for VIP transportation operations.

## Monorepo Structure

- apps/api: NestJS backend (tenant-aware, RLS-ready)
- apps/web: React/Vite operations dashboard
- tech-spec.md: Product and architecture specification

## Quick Start

1. Copy .env.example to .env.
2. Start infrastructure:

   docker compose up -d

3. Install dependencies:

   npm install

4. Generate Prisma client:

   npm run prisma:generate

5. Apply database migration:

   npm run prisma:migrate

6. Seed demo tenant and user:

   npm --workspace @vipflow/api run prisma:seed

7. Run API in dev mode:

   npm run dev:api

8. Run web dashboard in dev mode:

   npm run dev:web

9. Run event archive + triage smoke test (API must be running):

   npm run smoke:triage

10. Run API integration checks (API must be running):

   npm run test:integration:api

11. Run observability stack (Prometheus + Grafana):

   docker compose up -d prometheus grafana

## Demo Authentication Flow

1. Login with tenant header:

   POST /auth/login
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   body: { "email": "operator@demo.local", "password": "Password123!" }

2. Refresh token:

   POST /auth/refresh
   body: { "refreshToken": "..." }

3. Logout current session:

   POST /auth/logout
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   authorization: Bearer <accessToken>

## Authorization Rules

- All routes except /health, /auth/login, and /auth/refresh require a Bearer access token.
- Protected routes require x-tenant-id matching the token tenant.
- If x-user-id is provided, it must match the token subject.
- Reservation routes require role: SUPER_ADMIN, TENANT_ADMIN, or OPERATOR.
- Refresh token reuse detection is enabled. Reusing a rotated refresh token locks active sessions and temporarily blocks login for 15 minutes.

## Demo Reservation Flow

1. Create reservation:

   POST /reservations
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   body: { "customerName": "John Doe", "pickupLocation": "IST", "dropoffLocation": "Taksim", "pickupTime": "2026-05-23T10:00:00.000Z" }

2. List reservations:

   GET /reservations
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   authorization: Bearer <accessToken>

3. Update reservation status:

   PATCH /reservations/:id/status
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   authorization: Bearer <accessToken>
   body: { "status": "CONFIRMED", "reason": "Operator approved" }

## Live Operations Endpoint

1. Get dashboard summary:

   GET /operations/live-dashboard
   x-tenant-id: <seed_output_tenantId>
   x-user-id: <seed_output_userId>
   authorization: Bearer <accessToken>

## Web Operations Dashboard

- URL: http://localhost:5173
- Required inputs in UI:
   - API Base URL
   - Tenant ID
   - User ID
   - Access Token
- Features:
   - live-dashboard metrics
   - notification-deliveries list
   - notification-dead-letter list
   - notification-deliveries export (CSV/JSON)
   - notification-dead-letter retry with dry-run support
   - realtime reservation.created / reservation.status.updated stream
   - auto reconnect status, last connected timestamp, realtime toast notifications
   - event type/reservation filtering and subscribe.reservation controls
   - pause/resume event feed, max event cap, clear log actions
   - subscribed-only event mode and realtime event JSON export
   - socket health self-test (manual + periodic ping, RTT and failure metrics)
   - event severity badges and date-range filtered realtime export
   - persistent event archive API with date-range filter and CSV/JSON export
   - alarm triage workflow (acknowledge, snooze, assign, resolve) with priority queue ordering
   - event archive cursor pagination and operations metrics endpoint

## Realtime WebSocket

Namespace:

- /ws/operations

## Metrics And Dashboards

- Prometheus metrics endpoint (public):
   - GET /metrics
- Operations JSON metrics endpoint (authorized):
   - GET /operations/metrics
- Prometheus UI:
   - http://localhost:9090
- Grafana UI:
   - http://localhost:3001 (admin/admin)
- Provisioned dashboard:
   - VIPFlow Operations Metrics

Grafana acceptance checklist:

1. Open VIPFlow Operations Metrics dashboard in Grafana.
2. Set time range to Last 15 minutes or Last 1 hour.
3. Verify event archive query total panel is greater than or equal to 1 after archive requests.
4. Verify triage action total panel is greater than or equal to 1 after acknowledge/snooze/assign/resolve.
5. Verify triage failures panel stays at 0 in a healthy flow.
6. If values are stale, click Refresh on the dashboard and re-check.

Grafana kabul kontrol listesi (TR):

1. Grafana içinde VIPFlow Operations Metrics dashboard'unu acin.
2. Zaman araligini Son 15 dakika veya Son 1 saat olarak secin.
3. Archive isteklerinden sonra event archive query total panelinin 1 veya daha buyuk oldugunu dogrulayin.
4. acknowledge/snooze/assign/resolve aksiyonlarindan sonra triage action total panelinin 1 veya daha buyuk oldugunu dogrulayin.
5. Saglikli akista triage failures panelinin 0 kaldigini dogrulayin.
6. Degerler eski gorunuyorsa dashboard uzerinden Refresh yapip yeniden kontrol edin.

Quick command set (generate metrics + verify):

```bash
# 1) Generate archive and triage metrics
npm run smoke:triage
npm run test:integration:api

# 2) Verify current metrics via Prometheus
curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_event_archive_queries_total'

curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_triage_actions_total'

curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_triage_failures_total'

# 3) Open Grafana dashboard
"$BROWSER" 'http://localhost:3001/d/vipflow-operations-metrics/vipflow-operations-metrics'
```

Hizli komut seti (metrik uret + dogrula):

```bash
# 1) Archive ve triage metriklerini uret
npm run smoke:triage
npm run test:integration:api

# 2) Prometheus uzerinden anlik degerleri kontrol et
curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_event_archive_queries_total'

curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_triage_actions_total'

curl -sS --get 'http://localhost:9090/api/v1/query' \
   --data-urlencode 'query=vipflow_operations_triage_failures_total'

# 3) Grafana dashboard ac
"$BROWSER" 'http://localhost:3001/d/vipflow-operations-metrics/vipflow-operations-metrics'
```

Handshake requirements:

- auth.token: Bearer <accessToken> or raw access token
- auth.tenantId: <tenantId>

Rooms:

- tenant.<tenantId>
- tenant.<tenantId>.user.<userId>
- tenant.<tenantId>.reservation.<reservationId>

Inbound events:

- ping
- subscribe.reservation { reservationId }

Outbound events:

- reservation.created
- reservation.status.updated

Scaling:

- Socket.IO Redis adapter is enabled when SOCKET_IO_REDIS_URL (or REDIS_URL) is configured.
- This allows tenant room broadcasts across multiple API instances.

## Notification Adapter Layer

- Queue notifications are dispatched through provider adapters.
- Providers:
   - FCM provider (legacy HTTP endpoint)
   - WhatsApp Cloud API provider
- If credentials/targets are missing, providers skip sending and log the reason.

Environment configuration:

- FCM_SERVER_KEY
- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- WHATSAPP_API_VERSION (default v20.0)

Payload metadata options used by providers:

- deviceTokens: string[] for FCM broadcast
- toPhone: string for WhatsApp recipient

Recipient resolution:

- Notification targets are resolved from database by tenant context.
- Default recipients are active operations roles: SUPER_ADMIN, TENANT_ADMIN, OPERATOR.
- Data sources:
   - users.phoneE164 for WhatsApp targets
   - user_devices.token for FCM targets

Delivery persistence and retry behavior:

- Every channel attempt is persisted in notification_deliveries.
- Delivery status values:
   - SENT
   - SKIPPED
   - FAILED
- Error categories:
   - TRANSIENT (retryable)
   - PERMANENT (non-retryable)
- Queue worker retries only when at least one channel fails with TRANSIENT category.

Admin observability endpoint:

- GET /operations/notification-deliveries?limit=25
- Returns latest delivery logs with channel, status, attemptNumber, queue job identity, and error metadata.

Filtering and dead-letter queries:

- GET /operations/notification-deliveries?limit=25&offset=0&status=FAILED&channel=FCM&errorCategory=TRANSIENT&reservationId=<id>&from=2026-05-23T00:00:00.000Z&to=2026-05-24T00:00:00.000Z
- GET /operations/notification-dead-letter?limit=25&offset=0&errorCategory=TRANSIENT
- GET /operations/notification-deliveries/export?format=csv&limit=1000&offset=0&status=FAILED
- GET /operations/notification-deliveries/export?format=json&channel=WHATSAPP&from=2026-05-23T00:00:00.000Z
- POST /operations/notification-dead-letter/retry
   - body example: { "limit": 50, "errorCategory": "TRANSIENT", "includePermanent": false, "dryRun": true }
   - optional filters: deliveryIds[], reservationId, from, to
   - response: dryRun, selected, wouldEnqueue, enqueued, skippedPermanent, duplicateGroups

## Status Transition Rules

- PENDING_APPROVAL -> CONFIRMED | CANCELLED | FAILED
- CONFIRMED -> DRIVER_ASSIGNED | CANCELLED | DELAYED
- DRIVER_ASSIGNED -> DRIVER_ACCEPTED | CANCELLED | DELAYED | FAILED
- DRIVER_ACCEPTED -> DRIVER_EN_ROUTE | CANCELLED | DELAYED
- DRIVER_EN_ROUTE -> CUSTOMER_PICKED_UP | NO_SHOW | DELAYED
- CUSTOMER_PICKED_UP -> IN_PROGRESS
- IN_PROGRESS -> COMPLETED | FAILED | DELAYED
- DELAYED -> DRIVER_EN_ROUTE | CUSTOMER_PICKED_UP | IN_PROGRESS | CANCELLED | FAILED

## Next Steps

- Add refresh token reuse detection and suspicious-session lockout.
- Add Socket.IO gateway with tenant channels.
- Add notification providers (FCM and WhatsApp Business API).
- Add frontend operations dashboard and approval queue pages.
