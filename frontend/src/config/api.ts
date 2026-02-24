export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

/**
 * Wrapper around fetch that includes credentials (cookies) for cross-origin requests.
 * Use this for all API calls to ensure auth cookies are sent in cloud mode.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, { ...init, credentials: 'include' });
}
