import { useState, useEffect, useRef } from 'react';
import { API_BASE_URL, apiFetch } from '../config/api';

export interface Metric {
    id: number;
    step: number;
    data: Record<string, number>;
    created_at: string;
}

export interface LogEntry {
    id: number;
    session_id: string;
    timestamp: string;
    stream: string;
    message: string;
    created_at: string;
}

interface UseSSEOptions {
    sessionId: string;
    enabled?: boolean;
}

export function useMetricsSSE({ sessionId, enabled = true }: UseSSEOptions) {
    const [metrics, setMetrics] = useState<Metric[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const seenIds = useRef(new Set<number>());
    const eventSourceRef = useRef<EventSource | null>(null);

    useEffect(() => {
        if (!enabled || !sessionId) return;

        const apiUrl = API_BASE_URL;
        let aborted = false;

        // Reset state
        seenIds.current = new Set();
        setMetrics([]);

        // First fetch initial/historical metrics, then connect to SSE
        const initialize = async () => {
            try {
                // Fetch historical metrics
                console.log('[Metrics] Fetching initial metrics...');
                const response = await apiFetch(`/api/sessions/${sessionId}/metrics`);
                if (aborted) return;
                if (response.ok) {
                    const data: Metric[] = await response.json();
                    console.log('[Metrics] Fetched initial metrics:', data.length);

                    // Track seen IDs
                    data.forEach(m => seenIds.current.add(m.id));
                    setMetrics(data);
                }
            } catch (e) {
                if (aborted) return;
                console.error('[Metrics] Failed to fetch initial metrics:', e);
            }

            if (aborted) return;

            // Then connect to SSE stream for live updates
            const es = new EventSource(
                `${apiUrl}/api/sessions/${sessionId}/metrics/stream`,
                { withCredentials: true }
            );
            eventSourceRef.current = es;

            es.onopen = () => {
                setIsConnected(true);
                setError(null);
                console.log('[SSE] Connected to metrics stream');
            };

            es.onmessage = (event) => {
                try {
                    const metric: Metric = JSON.parse(event.data);
                    console.log('[SSE] Received metric:', metric);

                    // Avoid duplicates
                    if (!seenIds.current.has(metric.id)) {
                        seenIds.current.add(metric.id);
                        setMetrics((prev) => [...prev, metric]);
                    }
                } catch (e) {
                    console.error('[SSE] Failed to parse metric:', e);
                }
            };

            es.onerror = (e) => {
                console.error('[SSE] Connection error:', e);
                setIsConnected(false);
                setError(new Error('SSE connection failed'));
                es.close();
            };
        };

        initialize();

        return () => {
            aborted = true;
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
            setIsConnected(false);
        };
    }, [sessionId, enabled]);

    return { metrics, isConnected, error };
}

export function useLogsSSE({ sessionId, enabled = true }: UseSSEOptions) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const seenIds = useRef(new Set<number>());
    const eventSourceRef = useRef<EventSource | null>(null);

    useEffect(() => {
        if (!enabled || !sessionId) return;

        const apiUrl = API_BASE_URL;
        let aborted = false;

        seenIds.current = new Set();
        setLogs([]);
        setIsLoading(true);

        const initialize = async () => {
            try {
                const response = await apiFetch(`/api/sessions/${sessionId}/logs?limit=5000`);
                if (aborted) return;
                if (response.ok) {
                    const data: LogEntry[] = await response.json();
                    data.forEach(l => seenIds.current.add(l.id));
                    setLogs(data);
                }
            } catch (e) {
                if (aborted) return;
                console.error('[Logs] Failed to fetch initial logs:', e);
            } finally {
                if (!aborted) setIsLoading(false);
            }

            if (aborted) return;

            const es = new EventSource(
                `${apiUrl}/api/sessions/${sessionId}/logs/stream`,
                { withCredentials: true }
            );
            eventSourceRef.current = es;

            es.onopen = () => {
                setIsConnected(true);
                setError(null);
            };

            es.onmessage = (event) => {
                try {
                    const log: LogEntry = JSON.parse(event.data);
                    if (!seenIds.current.has(log.id)) {
                        seenIds.current.add(log.id);
                        setLogs((prev) => {
                            const next = [...prev, log];
                            // Cap at 5000 entries for performance
                            return next.length > 5000 ? next.slice(-5000) : next;
                        });
                    }
                } catch (e) {
                    console.error('[SSE] Failed to parse log:', e);
                }
            };

            es.onerror = () => {
                setIsConnected(false);
                setError(new Error('SSE connection failed'));
                es.close();
            };
        };

        initialize();

        return () => {
            aborted = true;
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
            setIsConnected(false);
        };
    }, [sessionId, enabled]);

    return { logs, isLoading, isConnected, error };
}
