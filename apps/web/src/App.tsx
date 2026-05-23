import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";
import {
  DashboardResponse,
  DeadLetterRetryResponse,
  EventArchiveResponse,
  EventArchiveRow,
  EventTriageResponse,
  OperationsMetricsResponse,
  DeliveryResponse,
  DeliveryRow
} from "./types";

type Credentials = {
  apiBaseUrl: string;
  tenantId: string;
  userId: string;
  accessToken: string;
};

type LoadState = "idle" | "loading" | "success" | "error";
type SocketState = "disconnected" | "connecting" | "connected" | "error";

type RealtimeEvent = {
  type: "reservation.created" | "reservation.status.updated";
  reservationId: string;
  at: string;
  detail: string;
};

type EventSeverity = "high" | "medium" | "low";

type EventTypeFilter = "ALL" | "reservation.created" | "reservation.status.updated";

type ArchiveSeverityFilter = "ALL" | "LOW" | "MEDIUM" | "HIGH";
type ArchiveTriageFilter = "ALL" | "OPEN" | "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED";
type ArchiveEventTypeFilter = "ALL" | "RESERVATION_CREATED" | "RESERVATION_STATUS_UPDATED";
type TriageAction = "acknowledge" | "snooze" | "assign" | "resolve";

type Toast = {
  id: string;
  type: "info" | "success" | "error";
  message: string;
};

type SocketHealth = "unknown" | "healthy" | "degraded" | "down";

const defaultApiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

const initialCredentials: Credentials = {
  apiBaseUrl: defaultApiBaseUrl,
  tenantId: "",
  userId: "",
  accessToken: ""
};

function buildHeaders(credentials: Credentials): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-tenant-id": credentials.tenantId,
    "x-user-id": credentials.userId,
    authorization: `Bearer ${credentials.accessToken}`
  };
}

function toLocalDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("tr-TR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function downloadBlob(content: string, type: string, fileName: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toSocketUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.startsWith("https://")) {
    return apiBaseUrl.replace("https://", "wss://") + "/ws/operations";
  }

  if (apiBaseUrl.startsWith("http://")) {
    return apiBaseUrl.replace("http://", "ws://") + "/ws/operations";
  }

  return apiBaseUrl + "/ws/operations";
}

export function App(): React.JSX.Element {
  const [credentials, setCredentials] = useState<Credentials>(initialCredentials);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryResponse | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeliveryResponse | null>(null);
  const [eventArchive, setEventArchive] = useState<EventArchiveResponse | null>(null);
  const [operationsMetrics, setOperationsMetrics] = useState<OperationsMetricsResponse | null>(null);
  const [eventTriageResult, setEventTriageResult] = useState<EventTriageResponse | null>(null);
  const [retryResult, setRetryResult] = useState<DeadLetterRetryResponse | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string>("Bağlantı bilgilerini girip verileri çekebilirsin.");
  const [socketState, setSocketState] = useState<SocketState>("disconnected");
  const [socketMessage, setSocketMessage] = useState<string>("Canli akis bagli degil.");
  const [socketHealth, setSocketHealth] = useState<SocketHealth>("unknown");
  const [lastPingAt, setLastPingAt] = useState<string | null>(null);
  const [lastPingRttMs, setLastPingRttMs] = useState<number | null>(null);
  const [pingFailureCount, setPingFailureCount] = useState<number>(0);
  const [consecutivePingFailureCount, setConsecutivePingFailureCount] = useState<number>(0);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [isEventFeedPaused, setIsEventFeedPaused] = useState<boolean>(false);
  const [maxEvents, setMaxEvents] = useState<number>(20);
  const [suppressedEventCount, setSuppressedEventCount] = useState<number>(0);
  const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>("ALL");
  const [eventReservationFilter, setEventReservationFilter] = useState<string>("");
  const [eventFrom, setEventFrom] = useState<string>("");
  const [eventTo, setEventTo] = useState<string>("");
  const [onlySubscribedReservationEvents, setOnlySubscribedReservationEvents] = useState<boolean>(false);
  const [subscriptionReservationId, setSubscriptionReservationId] = useState<string>("");
  const [lastSubscribedReservationId, setLastSubscribedReservationId] = useState<string>("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [limit, setLimit] = useState<number>(25);
  const [errorCategory, setErrorCategory] = useState<string>("");
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [archiveSeverity, setArchiveSeverity] = useState<ArchiveSeverityFilter>("ALL");
  const [archiveTriageStatus, setArchiveTriageStatus] = useState<ArchiveTriageFilter>("ALL");
  const [archiveEventType, setArchiveEventType] = useState<ArchiveEventTypeFilter>("ALL");
  const [archiveReservationFilter, setArchiveReservationFilter] = useState<string>("");
  const [archiveFrom, setArchiveFrom] = useState<string>("");
  const [archiveTo, setArchiveTo] = useState<string>("");
  const [archiveCursorId, setArchiveCursorId] = useState<string>("");
  const [archiveHasMore, setArchiveHasMore] = useState<boolean>(false);
  const [onlyOpenQuickFilter, setOnlyOpenQuickFilter] = useState<boolean>(false);
  const [selectedArchiveEventIds, setSelectedArchiveEventIds] = useState<string[]>([]);
  const [triageInFlightIds, setTriageInFlightIds] = useState<string[]>([]);
  const [triageAction, setTriageAction] = useState<TriageAction>("acknowledge");
  const [triageAssignedUserId, setTriageAssignedUserId] = useState<string>("");
  const [triageSnoozedUntil, setTriageSnoozedUntil] = useState<string>("");
  const socketRef = useRef<Socket | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const healthIntervalRef = useRef<number | null>(null);

  const canFetch = useMemo(() => {
    return Boolean(credentials.tenantId && credentials.userId && credentials.accessToken);
  }, [credentials]);

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      const typeMatches = eventTypeFilter === "ALL" || event.type === eventTypeFilter;
      const reservationMatches =
        !eventReservationFilter ||
        event.reservationId.toLowerCase().includes(eventReservationFilter.trim().toLowerCase());
      const fromMatches = !eventFrom || new Date(event.at).getTime() >= new Date(eventFrom).getTime();
      const toMatches = !eventTo || new Date(event.at).getTime() <= new Date(eventTo).getTime();
      const subscribedOnlyMatches =
        !onlySubscribedReservationEvents ||
        (lastSubscribedReservationId
          ? event.reservationId.toLowerCase() === lastSubscribedReservationId.toLowerCase()
          : false);

      return typeMatches && reservationMatches && fromMatches && toMatches && subscribedOnlyMatches;
    });
  }, [
    eventFrom,
    eventReservationFilter,
    eventTo,
    eventTypeFilter,
    events,
    lastSubscribedReservationId,
    onlySubscribedReservationEvents
  ]);

  const priorityQueue = useMemo(() => {
    const items = eventArchive?.items ?? [];
    const triageScore: Record<EventArchiveRow["triageStatus"], number> = {
      OPEN: 0,
      ACKNOWLEDGED: 1,
      SNOOZED: 2,
      RESOLVED: 3
    };
    const severityScore: Record<EventArchiveRow["severity"], number> = {
      HIGH: 3,
      MEDIUM: 2,
      LOW: 1
    };

    return [...items].sort((a, b) => {
      const triageDiff = triageScore[a.triageStatus] - triageScore[b.triageStatus];
      if (triageDiff !== 0) {
        return triageDiff;
      }

      const severityDiff = severityScore[b.severity] - severityScore[a.severity];
      if (severityDiff !== 0) {
        return severityDiff;
      }

      return new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime();
    });
  }, [eventArchive]);

  function getEventSeverity(event: RealtimeEvent): EventSeverity {
    const detail = event.detail.toUpperCase();
    if (
      detail.includes("FAILED") ||
      detail.includes("CANCELLED") ||
      detail.includes("NO_SHOW") ||
      detail.includes("DELAYED")
    ) {
      return "high";
    }

    if (event.type === "reservation.status.updated") {
      return "medium";
    }

    return "low";
  }

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${credentials.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...buildHeaders(credentials),
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  function appendEvent(event: RealtimeEvent): void {
    if (isEventFeedPaused) {
      setSuppressedEventCount((prev) => prev + 1);
      return;
    }

    const safeMax = Math.max(5, Math.min(maxEvents, 100));
    setEvents((prev) => [event, ...prev].slice(0, safeMax));
  }

  function pushToast(type: Toast["type"], messageText: string): void {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [{ id, type, message: messageText }, ...prev].slice(0, 4));

    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToasts((prev) => prev.slice(0, Math.max(prev.length - 1, 0)));
    }, 3500);
  }

  function scheduleRefresh(): void {
    if (isEventFeedPaused) {
      return;
    }

    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      void loadDashboard({ silent: true });
    }, 400);
  }

  function stopHealthInterval(): void {
    if (healthIntervalRef.current) {
      window.clearInterval(healthIntervalRef.current);
      healthIntervalRef.current = null;
    }
  }

  function startHealthInterval(): void {
    stopHealthInterval();
    healthIntervalRef.current = window.setInterval(() => {
      void runSocketHealthCheck(true);
    }, 20000);
  }

  async function runSocketHealthCheck(silent: boolean): Promise<void> {
    const socket = socketRef.current;
    if (!socket || socketState !== "connected") {
      setSocketHealth("unknown");
      if (!silent) {
        pushToast("error", "Health check icin aktif socket baglantisi yok.");
      }
      return;
    }

    const startedAt = Date.now();

    try {
      const response = await socket.timeout(5000).emitWithAck("ping");
      const rtt = Date.now() - startedAt;

      setLastPingAt(new Date().toISOString());
      setLastPingRttMs(rtt);
      setConsecutivePingFailureCount(0);
      setSocketHealth(rtt <= 600 ? "healthy" : "degraded");

      if (!silent) {
        const suffix = response?.ok ? "ok" : "unexpected";
        pushToast("success", `Socket health check: ${suffix} (${rtt}ms)`);
      }
    } catch {
      setLastPingAt(new Date().toISOString());
      setPingFailureCount((prev) => prev + 1);
      setConsecutivePingFailureCount((prev) => {
        const next = prev + 1;
        setSocketHealth(next >= 2 ? "down" : "degraded");
        return next;
      });

      if (!silent) {
        pushToast("error", "Socket health check basarisiz (timeout).");
      }
    }
  }

  async function loadDashboard(options?: { silent?: boolean; appendArchive?: boolean }): Promise<void> {
    if (!canFetch) {
      setMessage("Tenant, user ve access token alanları zorunlu.");
      return;
    }

    if (!options?.silent) {
      setStatus("loading");
      setMessage("Dashboard verileri alınıyor...");
    }

    try {
      const [dashboardData, deliveryData, deadLetterData, archiveData, metricsData] = await Promise.all([
        fetchJson<DashboardResponse>("/operations/live-dashboard"),
        fetchJson<DeliveryResponse>(
          `/operations/notification-deliveries?limit=${limit}&offset=0${
            errorCategory ? `&errorCategory=${encodeURIComponent(errorCategory)}` : ""
          }`
        ),
        fetchJson<DeliveryResponse>(
          `/operations/notification-dead-letter?limit=${limit}&offset=0${
            errorCategory ? `&errorCategory=${encodeURIComponent(errorCategory)}` : ""
          }`
        ),
        fetchJson<EventArchiveResponse>(buildEventArchiveQuery(options?.appendArchive === true)),
        fetchJson<OperationsMetricsResponse>("/operations/metrics")
      ]);

      const nextArchiveItems = options?.appendArchive
        ? [...(eventArchive?.items ?? []), ...archiveData.items]
        : archiveData.items;

      const archiveIds = new Set(nextArchiveItems.map((item) => item.id));
      setSelectedArchiveEventIds((prev) => prev.filter((id) => archiveIds.has(id)));

      setDashboard(dashboardData);
      setDeliveries(deliveryData);
      setDeadLetters(deadLetterData);
      setEventArchive({
        items: nextArchiveItems,
        total: archiveData.total,
        nextCursorId: archiveData.nextCursorId
      });
      setOperationsMetrics(metricsData);
      setArchiveHasMore(Boolean(archiveData.nextCursorId));
      setArchiveCursorId(archiveData.nextCursorId ?? "");
      setStatus("success");
      if (!options?.silent) {
        setMessage("Veriler başarıyla güncellendi.");
      }
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Bilinmeyen hata");
    }
  }

  function disconnectSocket(): void {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    stopHealthInterval();
    setSocketState("disconnected");
    setSocketMessage("Canli akis bagli degil.");
    setSocketHealth("unknown");
    pushToast("info", "Canli akis baglantisi sonlandirildi.");
  }

  function connectSocket(): void {
    if (!canFetch) {
      setSocketMessage("Canli akis icin tenant, user ve token gir.");
      return;
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const socketUrl = toSocketUrl(credentials.apiBaseUrl);
    setSocketState("connecting");
    setSocketMessage("Socket baglantisi kuruluyor...");

    const socket = io(socketUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: {
        token: credentials.accessToken,
        tenantId: credentials.tenantId
      }
    });

    socket.on("connect", () => {
      setSocketState("connected");
      setSocketMessage("Canli akis baglandi.");
      setLastConnectedAt(new Date().toISOString());
      setSocketHealth("healthy");
      setConsecutivePingFailureCount(0);
      void runSocketHealthCheck(true);
      startHealthInterval();
      pushToast("success", "Canli akis baglantisi kuruldu.");

      const trimmedReservation = subscriptionReservationId.trim();
      if (trimmedReservation) {
        socket.emit("subscribe.reservation", { reservationId: trimmedReservation });
        setLastSubscribedReservationId(trimmedReservation);
      }
    });

    socket.on("connect_error", (error: Error) => {
      setSocketState("error");
      setSocketMessage(`Baglanti hatasi: ${error.message}`);
      setSocketHealth("down");
      pushToast("error", `Socket baglanti hatasi: ${error.message}`);
    });

    socket.on("reservation.created", (payload: { reservationId: string; pickupTime: string }) => {
      appendEvent({
        type: "reservation.created",
        reservationId: payload.reservationId,
        at: new Date().toISOString(),
        detail: `Yeni rezervasyon olustu. Pickup: ${toLocalDate(payload.pickupTime)}`
      });
      pushToast("info", `Yeni rezervasyon eventi: ${payload.reservationId.slice(0, 8)}`);
      scheduleRefresh();
    });

    socket.on(
      "reservation.status.updated",
      (payload: { reservationId: string; previousStatus: string; nextStatus: string; reason?: string }) => {
        appendEvent({
          type: "reservation.status.updated",
          reservationId: payload.reservationId,
          at: new Date().toISOString(),
          detail: `${payload.previousStatus} -> ${payload.nextStatus}${payload.reason ? ` (${payload.reason})` : ""}`
        });
        pushToast(
          "info",
          `Status eventi: ${payload.reservationId.slice(0, 8)} ${payload.previousStatus} -> ${payload.nextStatus}`
        );
        scheduleRefresh();
      }
    );

    socket.io.on("reconnect_attempt", (attempt: number) => {
      setSocketState("connecting");
      setSocketMessage(`Yeniden baglanti deneniyor (#${attempt})...`);
    });

    socket.io.on("reconnect", (attempt: number) => {
      setSocketState("connected");
      setSocketMessage(`Yeniden baglanti basarili (#${attempt}).`);
      setLastConnectedAt(new Date().toISOString());
      setSocketHealth("healthy");
      void runSocketHealthCheck(true);
      pushToast("success", "Socket yeniden baglandi.");
    });

    socket.on("disconnect", () => {
      stopHealthInterval();
      setSocketState("disconnected");
      setSocketMessage("Canli akis baglantisi kapandi. Otomatik yeniden baglanma aktif.");
      setSocketHealth("degraded");
      pushToast("info", "Socket baglantisi koptu, otomatik tekrar denenecek.");
    });

    socketRef.current = socket;
  }

  function subscribeReservationRoom(): void {
    const reservationId = subscriptionReservationId.trim();
    if (!reservationId) {
      pushToast("error", "Abonelik icin reservation ID gir.");
      return;
    }

    if (!socketRef.current || socketState !== "connected") {
      pushToast("error", "Once realtime baglantisini kur.");
      return;
    }

    socketRef.current.emit("subscribe.reservation", { reservationId });
    setLastSubscribedReservationId(reservationId);
    pushToast("success", `Reservation odasina abone olundu: ${reservationId.slice(0, 12)}`);
  }

  function clearEventLog(): void {
    setEvents([]);
    setSuppressedEventCount(0);
    pushToast("info", "Event log temizlendi.");
  }

  function exportEventLogJson(): void {
    const dateRangeLabel = `${eventFrom || "start"}_${eventTo || "end"}`
      .replace(/[\s:T]/g, "-")
      .replace(/[^a-zA-Z0-9\-_]/g, "");

    const payload = {
      exportedAt: new Date().toISOString(),
      filteredBy: {
        reservationSearch: eventReservationFilter,
        from: eventFrom || null,
        to: eventTo || null,
        onlySubscribedReservationEvents,
        subscribedReservationId: lastSubscribedReservationId || null
      },
      count: filteredEvents.length,
      items: filteredEvents
    };

    downloadBlob(
      JSON.stringify(payload, null, 2),
      "application/json",
      `realtime-events-${dateRangeLabel || "all"}.json`
    );
    pushToast("success", `Event JSON export olusturuldu (${filteredEvents.length} kayit).`);
  }

  async function handleExport(format: "csv" | "json"): Promise<void> {
    if (!canFetch) {
      setMessage("Önce kimlik alanlarını doldur.");
      return;
    }

    try {
      const path = `/operations/notification-deliveries/export?format=${format}&limit=1000&offset=0`;
      const response = await fetch(`${credentials.apiBaseUrl}${path}`, {
        headers: buildHeaders(credentials)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const content = await response.text();
      const ext = format === "csv" ? "csv" : "json";
      downloadBlob(content, format === "csv" ? "text/csv" : "application/json", `delivery-export.${ext}`);
      setMessage(`${format.toUpperCase()} dışa aktarımı indirildi.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export hatası");
    }
  }

  function buildEventArchiveQuery(includeCursor: boolean = true): string {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: "0"
    });

    if (includeCursor && archiveCursorId) {
      params.set("cursorId", archiveCursorId);
    }

    if (archiveSeverity !== "ALL") {
      params.set("severity", archiveSeverity);
    }

    if (onlyOpenQuickFilter) {
      params.set("triageStatus", "OPEN");
    } else if (archiveTriageStatus !== "ALL") {
      params.set("triageStatus", archiveTriageStatus);
    }

    if (archiveEventType !== "ALL") {
      params.set("eventType", archiveEventType);
    }

    if (archiveReservationFilter.trim()) {
      params.set("reservationId", archiveReservationFilter.trim());
    }

    if (archiveFrom) {
      params.set("from", archiveFrom);
    }

    if (archiveTo) {
      params.set("to", archiveTo);
    }

    return `/operations/event-archive?${params.toString()}`;
  }

  function buildEventArchiveExportPath(format: "csv" | "json"): string {
    const query = buildEventArchiveQuery(false).replace("/operations/event-archive?", "");
    return `/operations/event-archive/export?format=${format}&${query}`;
  }

  function resetArchivePagination(): void {
    setArchiveCursorId("");
    setArchiveHasMore(false);
  }

  async function loadMoreArchive(): Promise<void> {
    if (!archiveHasMore || !archiveCursorId) {
      return;
    }

    await loadDashboard({ silent: true, appendArchive: true });
  }

  async function handleEventArchiveExport(format: "csv" | "json"): Promise<void> {
    if (!canFetch) {
      setMessage("Önce kimlik alanlarını doldur.");
      return;
    }

    try {
      const path = buildEventArchiveExportPath(format);
      const response = await fetch(`${credentials.apiBaseUrl}${path}`, {
        headers: buildHeaders(credentials)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const content = await response.text();
      const ext = format === "csv" ? "csv" : "json";
      downloadBlob(content, format === "csv" ? "text/csv" : "application/json", `event-archive-export.${ext}`);
      setMessage(`Event archive ${format.toUpperCase()} dışa aktarımı indirildi.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Archive export hatası");
    }
  }

  function toggleArchiveSelection(eventId: string): void {
    setSelectedArchiveEventIds((prev) => {
      if (prev.includes(eventId)) {
        return prev.filter((id) => id !== eventId);
      }

      return [...prev, eventId];
    });
  }

  function toggleSelectAllArchiveRows(): void {
    const ids = priorityQueue.map((row) => row.id);
    if (ids.length === 0) {
      return;
    }

    const allSelected = ids.every((id) => selectedArchiveEventIds.includes(id));
    if (allSelected) {
      setSelectedArchiveEventIds((prev) => prev.filter((id) => !ids.includes(id)));
      return;
    }

    setSelectedArchiveEventIds(Array.from(new Set([...selectedArchiveEventIds, ...ids])));
  }

  function applyOptimisticTriage(
    items: EventArchiveRow[],
    ids: string[],
    action: TriageAction,
    input: { assignedUserId?: string; snoozedUntil?: string }
  ): EventArchiveRow[] {
    const nowIso = new Date().toISOString();
    return items.map((item) => {
      if (!ids.includes(item.id)) {
        return item;
      }

      if (action === "acknowledge") {
        return {
          ...item,
          triageStatus: "ACKNOWLEDGED",
          acknowledgedAt: nowIso,
          acknowledgedByUserId: credentials.userId,
          snoozedUntil: undefined
        };
      }

      if (action === "resolve") {
        return {
          ...item,
          triageStatus: "RESOLVED",
          acknowledgedAt: nowIso,
          acknowledgedByUserId: credentials.userId,
          snoozedUntil: undefined
        };
      }

      if (action === "assign") {
        return {
          ...item,
          triageStatus: "ACKNOWLEDGED",
          assignedUserId: input.assignedUserId,
          acknowledgedAt: nowIso,
          acknowledgedByUserId: credentials.userId,
          snoozedUntil: undefined
        };
      }

      return {
        ...item,
        triageStatus: "SNOOZED",
        snoozedUntil: input.snoozedUntil,
        acknowledgedAt: nowIso,
        acknowledgedByUserId: credentials.userId
      };
    });
  }

  async function runEventTriage(eventIdsOverride?: string[], actionOverride?: TriageAction): Promise<void> {
    if (!canFetch) {
      setMessage("Önce kimlik alanlarını doldur.");
      return;
    }

    const targetIds = eventIdsOverride ?? selectedArchiveEventIds;
    const targetAction = actionOverride ?? triageAction;

    if (targetIds.length === 0) {
      setMessage("Triage icin en az bir archive event sec.");
      return;
    }

    const previousArchive = eventArchive;

    try {
      const payload: {
        eventIds: string[];
        action: TriageAction;
        snoozedUntil?: string;
        assignedUserId?: string;
      } = {
        eventIds: targetIds,
        action: targetAction
      };

      if (targetAction === "assign") {
        payload.assignedUserId = triageAssignedUserId.trim() || undefined;
      }

      if (targetAction === "snooze") {
        payload.snoozedUntil = triageSnoozedUntil || undefined;
      }

      setTriageInFlightIds(targetIds);
      if (eventArchive) {
        setEventArchive({
          ...eventArchive,
          items: applyOptimisticTriage(eventArchive.items, targetIds, targetAction, {
            assignedUserId: payload.assignedUserId,
            snoozedUntil: payload.snoozedUntil
          })
        });
      }

      const result = await fetchJson<EventTriageResponse>("/operations/event-archive/triage", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      setEventTriageResult(result);
      setMessage(`Triage: ${result.action} tamamlandi. Guncellenen kayit: ${result.updated}`);
      setTriageInFlightIds([]);
      await loadDashboard({ silent: true });
    } catch (error) {
      if (previousArchive) {
        setEventArchive(previousArchive);
      }
      setTriageInFlightIds([]);
      setMessage(error instanceof Error ? error.message : "Event triage hatası");
    }
  }

  async function runDeadLetterRetry(): Promise<void> {
    if (!canFetch) {
      setMessage("Önce kimlik alanlarını doldur.");
      return;
    }

    try {
      const result = await fetchJson<DeadLetterRetryResponse>("/operations/notification-dead-letter/retry", {
        method: "POST",
        body: JSON.stringify({
          limit,
          errorCategory: errorCategory || undefined,
          includePermanent: false,
          dryRun
        })
      });

      setRetryResult(result);
      setMessage(
        dryRun
          ? `Dry-run tamamlandı. Enqueue adayı: ${result.wouldEnqueue}`
          : `Retry tamamlandı. Kuyruğa alınan: ${result.enqueued}`
      );

      resetArchivePagination();
      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry hatası");
    }
  }

  function onCredentialsSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    resetArchivePagination();
    void loadDashboard();
  }

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      stopHealthInterval();
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  function renderDeliveryRow(row: DeliveryRow): React.JSX.Element {
    return (
      <tr key={row.id}>
        <td>{row.reservationId.slice(0, 8)}</td>
        <td>{row.channel}</td>
        <td>
          <span className={`chip chip-${row.status.toLowerCase()}`}>{row.status}</span>
        </td>
        <td>{row.errorCategory ?? "-"}</td>
        <td>{row.attemptNumber}</td>
        <td>{toLocalDate(row.createdAt)}</td>
      </tr>
    );
  }

  function archiveSeverityClass(severity: EventArchiveRow["severity"]): string {
    if (severity === "HIGH") {
      return "chip-high";
    }

    if (severity === "MEDIUM") {
      return "chip-medium";
    }

    return "chip-low";
  }

  function triageClass(statusValue: EventArchiveRow["triageStatus"]): string {
    if (statusValue === "OPEN") {
      return "chip-open";
    }

    if (statusValue === "ACKNOWLEDGED") {
      return "chip-ack";
    }

    if (statusValue === "SNOOZED") {
      return "chip-snoozed";
    }

    return "chip-resolved";
  }

  return (
    <div className="page-shell">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <aside className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </aside>

      <header className="hero">
        <p className="eyebrow">VIPFlow Operations</p>
        <h1>Canli Operasyon Kontrol Merkezi</h1>
        <p className="hero-sub">
          Dashboard, bildirim dagitimi, dead-letter analizi ve retry orkestrasyonu tek ekran.
        </p>
      </header>

      <section className="panel auth-panel">
        <form onSubmit={onCredentialsSubmit} className="auth-grid">
          <label>
            API Base URL
            <input
              value={credentials.apiBaseUrl}
              onChange={(event) => setCredentials((prev) => ({ ...prev, apiBaseUrl: event.target.value }))}
              placeholder="http://localhost:3000"
            />
          </label>
          <label>
            Tenant ID
            <input
              value={credentials.tenantId}
              onChange={(event) => setCredentials((prev) => ({ ...prev, tenantId: event.target.value }))}
              placeholder="Tenant UUID"
            />
          </label>
          <label>
            User ID
            <input
              value={credentials.userId}
              onChange={(event) => setCredentials((prev) => ({ ...prev, userId: event.target.value }))}
              placeholder="User UUID"
            />
          </label>
          <label>
            Access Token
            <input
              value={credentials.accessToken}
              onChange={(event) => setCredentials((prev) => ({ ...prev, accessToken: event.target.value }))}
              placeholder="Bearer token"
            />
          </label>

          <div className="filters-row">
            <label>
              Limit
              <input
                type="number"
                min={5}
                max={100}
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  resetArchivePagination();
                }}
              />
            </label>
            <label>
              Error Category
              <select value={errorCategory} onChange={(event) => setErrorCategory(event.target.value)}>
                <option value="">ALL</option>
                <option value="TRANSIENT">TRANSIENT</option>
                <option value="PERMANENT">PERMANENT</option>
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
              <span>Dead-letter retry dry-run</span>
            </label>
          </div>

          <div className="archive-filter-row">
            <label>
              Archive Severity
              <select
                value={archiveSeverity}
                onChange={(event) => {
                  setArchiveSeverity(event.target.value as ArchiveSeverityFilter);
                  resetArchivePagination();
                }}
              >
                <option value="ALL">ALL</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
            </label>
            <label>
              Archive Triage
              <select
                value={archiveTriageStatus}
                onChange={(event) => {
                  setArchiveTriageStatus(event.target.value as ArchiveTriageFilter);
                  resetArchivePagination();
                }}
              >
                <option value="ALL">ALL</option>
                <option value="OPEN">OPEN</option>
                <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
                <option value="SNOOZED">SNOOZED</option>
                <option value="RESOLVED">RESOLVED</option>
              </select>
            </label>
            <label>
              Archive Event Type
              <select
                value={archiveEventType}
                onChange={(event) => {
                  setArchiveEventType(event.target.value as ArchiveEventTypeFilter);
                  resetArchivePagination();
                }}
              >
                <option value="ALL">ALL</option>
                <option value="RESERVATION_CREATED">RESERVATION_CREATED</option>
                <option value="RESERVATION_STATUS_UPDATED">RESERVATION_STATUS_UPDATED</option>
              </select>
            </label>
            <label>
              Archive Reservation ID
              <input
                value={archiveReservationFilter}
                onChange={(event) => {
                  setArchiveReservationFilter(event.target.value);
                  resetArchivePagination();
                }}
                placeholder="Reservation UUID"
              />
            </label>
            <label>
              Archive From
              <input
                type="datetime-local"
                value={archiveFrom}
                onChange={(event) => {
                  setArchiveFrom(event.target.value);
                  resetArchivePagination();
                }}
              />
            </label>
            <label>
              Archive To
              <input
                type="datetime-local"
                value={archiveTo}
                onChange={(event) => {
                  setArchiveTo(event.target.value);
                  resetArchivePagination();
                }}
              />
            </label>
          </div>

          <div className="actions-row">
            <button type="submit" className="btn btn-primary" disabled={status === "loading"}>
              {status === "loading" ? "Yukleniyor..." : "Dashboard Yenile"}
            </button>
            <button type="button" className="btn" onClick={() => void handleExport("csv")}>
              CSV Export
            </button>
            <button type="button" className="btn" onClick={() => void handleExport("json")}>
              JSON Export
            </button>
            <button type="button" className="btn" onClick={() => void handleEventArchiveExport("csv")}>
              Archive CSV Export
            </button>
            <button type="button" className="btn" onClick={() => void handleEventArchiveExport("json")}>
              Archive JSON Export
            </button>
            <button type="button" className="btn btn-warn" onClick={() => void runDeadLetterRetry()}>
              {dryRun ? "Dry-Run Retry" : "Retry Calistir"}
            </button>
            <button type="button" className="btn" onClick={connectSocket}>
              Canli Akisa Baglan
            </button>
            <button type="button" className="btn" onClick={disconnectSocket}>
              Akisi Durdur
            </button>
          </div>
        </form>
        <p className={`status status-${status}`}>{message}</p>
        <p className={`status status-${socketState}`}>Realtime: {socketMessage}</p>
        <p className="status status-disconnected">
          Son basarili baglanti: {lastConnectedAt ? toLocalDate(lastConnectedAt) : "-"}
        </p>
      </section>

      <section className="panel realtime-panel">
        <div className="realtime-head">
          <h3>Canli Event Akisi</h3>
          <span className={`socket-pill socket-${socketState}`}>{socketState.toUpperCase()}</span>
        </div>

        <div className="realtime-controls">
          <label>
            Event Turu
            <select value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value as EventTypeFilter)}>
              <option value="ALL">ALL</option>
              <option value="reservation.created">reservation.created</option>
              <option value="reservation.status.updated">reservation.status.updated</option>
            </select>
          </label>
          <label>
            Event Reservation Filter
            <input
              value={eventReservationFilter}
              onChange={(event) => setEventReservationFilter(event.target.value)}
              placeholder="Reservation ID ara"
            />
          </label>
          <label>
            Event From
            <input
              type="datetime-local"
              value={eventFrom}
              onChange={(event) => setEventFrom(event.target.value)}
            />
          </label>
          <label>
            Event To
            <input
              type="datetime-local"
              value={eventTo}
              onChange={(event) => setEventTo(event.target.value)}
            />
          </label>
          <label>
            subscribe.reservation ID
            <input
              value={subscriptionReservationId}
              onChange={(event) => setSubscriptionReservationId(event.target.value)}
              placeholder="Reservation UUID"
            />
          </label>
          <label>
            Max Event
            <input
              type="number"
              min={5}
              max={100}
              value={maxEvents}
              onChange={(event) => setMaxEvents(Number(event.target.value))}
            />
          </label>
          <button type="button" className="btn" onClick={subscribeReservationRoom}>
            Reservation Aboneligi Ekle
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setIsEventFeedPaused((prev) => !prev)}
          >
            {isEventFeedPaused ? "Event Akisini Surdur" : "Event Akisini Duraklat"}
          </button>
          <button type="button" className="btn" onClick={clearEventLog}>
            Event Log Temizle
          </button>
          <button type="button" className="btn" onClick={exportEventLogJson}>
            Event JSON Export
          </button>
          <button type="button" className="btn" onClick={() => void runSocketHealthCheck(false)}>
            Socket Health Test
          </button>
        </div>

        <p className="muted">
          Son subscribe.reservation: {lastSubscribedReservationId || "-"}
        </p>
        <label className="toggle muted">
          <input
            type="checkbox"
            checked={onlySubscribedReservationEvents}
            onChange={(event) => setOnlySubscribedReservationEvents(event.target.checked)}
          />
          <span>Yalnizca subscribe edilen reservation eventleri</span>
        </label>
        <p className="muted">
          Event feed: {isEventFeedPaused ? "PAUSED" : "LIVE"} | Suppressed while paused: {suppressedEventCount}
        </p>
        <p className={`muted health health-${socketHealth}`}>
          Socket health: {socketHealth.toUpperCase()} | Last ping: {lastPingAt ? toLocalDate(lastPingAt) : "-"} |
          RTT: {lastPingRttMs ?? "-"} ms | Failures: {pingFailureCount} (consecutive {consecutivePingFailureCount})
        </p>

        {filteredEvents.length === 0 ? (
          <p className="muted">Henüz event yok. Baglanti kuruldugunda rezervasyon olaylari burada akar.</p>
        ) : (
          <ul className="event-list">
            {filteredEvents.map((event, index) => (
              <li key={`${event.reservationId}-${event.at}-${index}`}>
                <div className="event-top">
                  <strong>{event.type}</strong>
                  <span>{toLocalDate(event.at)}</span>
                </div>
                <span className={`severity severity-${getEventSeverity(event)}`}>
                  {getEventSeverity(event).toUpperCase()}
                </span>
                <p>Reservation: {event.reservationId}</p>
                <p>{event.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cards-grid">
        <article className="panel metric-card">
          <h2>Toplam Rezervasyon</h2>
          <p className="metric">{dashboard?.reservationSummary.total ?? "-"}</p>
        </article>
        <article className="panel metric-card">
          <h2>Bekleyen Onay</h2>
          <p className="metric">{dashboard?.reservationSummary.pendingApproval ?? "-"}</p>
        </article>
        <article className="panel metric-card">
          <h2>Aktif Operasyon</h2>
          <p className="metric">{dashboard?.reservationSummary.active ?? "-"}</p>
        </article>
        <article className="panel metric-card">
          <h2>Bugun Tamamlanan</h2>
          <p className="metric">{dashboard?.reservationSummary.completedToday ?? "-"}</p>
        </article>
      </section>

      <section className="tables-grid">
        <article className="panel table-panel">
          <h3>Delivery Log</h3>
          <table>
            <thead>
              <tr>
                <th>Reservation</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Error</th>
                <th>Attempt</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>{deliveries?.items.map(renderDeliveryRow)}</tbody>
          </table>
        </article>

        <article className="panel table-panel">
          <h3>Dead Letter</h3>
          <table>
            <thead>
              <tr>
                <th>Reservation</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Error</th>
                <th>Attempt</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>{deadLetters?.items.map(renderDeliveryRow)}</tbody>
          </table>

          <div className="retry-summary">
            <h4>Retry Sonucu</h4>
            <p>Selected: {retryResult?.selected ?? "-"}</p>
            <p>Would Enqueue: {retryResult?.wouldEnqueue ?? "-"}</p>
            <p>Enqueued: {retryResult?.enqueued ?? "-"}</p>
            <p>Skipped Permanent: {retryResult?.skippedPermanent ?? "-"}</p>
            <p>Duplicate Groups: {retryResult?.duplicateGroups ?? "-"}</p>
          </div>
        </article>

        <article className="panel table-panel">
          <h3>Event Archive Priority Queue</h3>

          <label className="toggle muted quick-toggle">
            <input
              type="checkbox"
              checked={onlyOpenQuickFilter}
              onChange={(event) => {
                setOnlyOpenQuickFilter(event.target.checked);
                resetArchivePagination();
              }}
            />
            <span>Quick filter: sadece OPEN eventler</span>
          </label>

          <div className="triage-controls">
            <button type="button" className="btn" onClick={toggleSelectAllArchiveRows}>
              {priorityQueue.length > 0 && priorityQueue.every((row) => selectedArchiveEventIds.includes(row.id))
                ? "Tumunu Kaldir"
                : "Tumunu Sec"}
            </button>
            <label>
              Action
              <select value={triageAction} onChange={(event) => setTriageAction(event.target.value as TriageAction)}>
                <option value="acknowledge">acknowledge</option>
                <option value="snooze">snooze</option>
                <option value="assign">assign</option>
                <option value="resolve">resolve</option>
              </select>
            </label>
            {triageAction === "assign" ? (
              <label>
                Assigned User ID
                <input
                  value={triageAssignedUserId}
                  onChange={(event) => setTriageAssignedUserId(event.target.value)}
                  placeholder="User UUID"
                />
              </label>
            ) : null}
            {triageAction === "snooze" ? (
              <label>
                Snoozed Until
                <input
                  type="datetime-local"
                  value={triageSnoozedUntil}
                  onChange={(event) => setTriageSnoozedUntil(event.target.value)}
                />
              </label>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => void runEventTriage()}>
              Triage Uygula ({selectedArchiveEventIds.length})
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th>Severity</th>
                <th>Triage</th>
                <th>Event</th>
                <th>Reservation</th>
                <th>Assigned</th>
                <th>Event At</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {priorityQueue.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedArchiveEventIds.includes(row.id)}
                      disabled={triageInFlightIds.includes(row.id)}
                      onChange={() => toggleArchiveSelection(row.id)}
                    />
                  </td>
                  <td>
                    <span className={`chip ${archiveSeverityClass(row.severity)}`}>{row.severity}</span>
                  </td>
                  <td>
                    <span className={`chip ${triageClass(row.triageStatus)}`}>{row.triageStatus}</span>
                  </td>
                  <td>
                    <div className="archive-title">{row.title}</div>
                    <div className="archive-detail">{row.detail}</div>
                  </td>
                  <td>{row.reservationId ? row.reservationId.slice(0, 8) : "-"}</td>
                  <td>{row.assignedUserId ? row.assignedUserId.slice(0, 8) : "-"}</td>
                  <td>{toLocalDate(row.eventAt)}</td>
                  <td>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="btn btn-inline"
                        disabled={triageInFlightIds.includes(row.id)}
                        onClick={() => void runEventTriage([row.id], "acknowledge")}
                      >
                        Ack
                      </button>
                      <button
                        type="button"
                        className="btn btn-inline"
                        disabled={triageInFlightIds.includes(row.id)}
                        onClick={() => void runEventTriage([row.id], "resolve")}
                      >
                        Resolve
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="archive-pagination">
            <button type="button" className="btn" disabled={!archiveHasMore} onClick={() => void loadMoreArchive()}>
              {archiveHasMore ? "Daha Fazla Yukle" : "Tum Kayitlar Yuklendi"}
            </button>
          </div>

          <div className="retry-summary">
            <h4>Archive / Triage Ozet</h4>
            <p>Total Archive Rows: {eventArchive?.total ?? "-"}</p>
            <p>Queue Rows (filtered): {priorityQueue.length}</p>
            <p>Next Cursor: {eventArchive?.nextCursorId ? eventArchive.nextCursorId.slice(0, 8) : "-"}</p>
            <p>Triage Action: {eventTriageResult?.action ?? "-"}</p>
            <p>Matched: {eventTriageResult?.matched ?? "-"}</p>
            <p>Updated: {eventTriageResult?.updated ?? "-"}</p>
          </div>

          <div className="retry-summary">
            <h4>Operational Metrics</h4>
            <p>Generated: {operationsMetrics ? toLocalDate(operationsMetrics.generatedAt) : "-"}</p>
            <p>Archive Query Count: {operationsMetrics?.eventArchiveQueryCount ?? "-"}</p>
            <p>Archive Query Latency Avg: {operationsMetrics?.eventArchiveQueryLatencyMsAvg ?? "-"} ms</p>
            <p>Triage Action Count: {operationsMetrics?.triageActionCount ?? "-"}</p>
            <p>Triage Latency Avg: {operationsMetrics?.triageActionLatencyMsAvg ?? "-"} ms</p>
            <p>Triage Failure Count: {operationsMetrics?.triageFailureCount ?? "-"}</p>
            <p>
              Triage Breakdown: ack {operationsMetrics?.triageActionBreakdown.acknowledge ?? "-"}, snooze{" "}
              {operationsMetrics?.triageActionBreakdown.snooze ?? "-"}, assign{" "}
              {operationsMetrics?.triageActionBreakdown.assign ?? "-"}, resolve{" "}
              {operationsMetrics?.triageActionBreakdown.resolve ?? "-"}
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}
