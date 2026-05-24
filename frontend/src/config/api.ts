/**
 * Client requests go through the Next.js `/api` rewrite layer.
 * Keeping this empty makes local dev, Docker, and deployed setups
 * all use the same origin from the browser's perspective.
 */
export const API_BASE_URL = "";

/**
 * Wrapper around fetch that includes credentials (cookies) for same-origin `/api` requests.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, { ...init, credentials: 'include' });
}
