import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";
import {
  DashboardResponse,
  DeadLetterRetryResponse,
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

  async function loadDashboard(options?: { silent?: boolean }): Promise<void> {
    if (!canFetch) {
      setMessage("Tenant, user ve access token alanları zorunlu.");
      return;
    }

    if (!options?.silent) {
      setStatus("loading");
      setMessage("Dashboard verileri alınıyor...");
    }

    try {
      const [dashboardData, deliveryData, deadLetterData] = await Promise.all([
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
        )
      ]);

      setDashboard(dashboardData);
      setDeliveries(deliveryData);
      setDeadLetters(deadLetterData);
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
        eventType: eventTypeFilter,
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

      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry hatası");
    }
  }

  function onCredentialsSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
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
                onChange={(event) => setLimit(Number(event.target.value))}
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
      </section>
    </div>
  );
}
