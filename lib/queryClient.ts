import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { viewerHeaders } from "@/lib/session-headers";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// The prompt-save API resolves the creator/owner from the session, never
// from the payload — without this header saves are anonymous and updates
// are rejected. Same token the PATCH publish call already forwards.
function sessionHeader(): Record<string, string> {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("turnkey_session_token")
      : null;
  return token ? { "X-Session-Token": token } : {};
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...sessionHeader(),
      },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });

    await throwIfResNotOk(res);
    return res;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
    async ({ queryKey }) => {
      try {
        const url = queryKey[0] as string;
        const res = await fetch(url, {
          headers: viewerHeaders(),
          credentials: "include",
        });

        if (unauthorizedBehavior === "returnNull" && res.status === 401) {
          return null;
        }

        await throwIfResNotOk(res);
        return await res.json();
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
    };

