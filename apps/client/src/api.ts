import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AppStatus {
  authenticated: boolean;
  userId?: string | null;
  deviceId?: string | null;
  syncing: boolean;
  error?: string | null;
  deviceVerified?: boolean;
  recoveryState?: string | null;
  hasSavedSession?: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  encrypted: boolean;
  encryption_known?: boolean;
  encryptionKnown?: boolean;
  joined: boolean;
  isSpace?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: string;
  body: string;
  timestamp: number;
  encrypted: boolean;
}

export function desktopAvailable(): boolean {
  return isTauri();
}

export const api = {
  spaceRooms: (roomId: string, from: string | null = null) =>
    invoke<{
      rooms: { id: string; name: string; joined: boolean }[];
      nextBatch: string | null;
    }>("space_rooms", { roomId, from }),
  status: () => invoke<AppStatus>("app_status"),
  login: (homeserver: string, username: string, password: string) =>
    invoke<void>("login", { homeserver, username, password }),
  loginSso: (homeserver: string) => invoke<void>("login_sso", { homeserver }),
  cancelLogin: () => invoke<void>("cancel_login"),
  recover: (recoveryKey: string) => invoke<void>("recover", { recoveryKey }),
  rooms: () => invoke<RoomSummary[]>("list_rooms"),
  messages: (roomId: string) =>
    invoke<ChatMessage[]>("get_messages", { roomId }),
  send: (roomId: string, body: string, transactionId: string) =>
    invoke<unknown>("send_message", { roomId, body, transactionId }),
  join: (roomId: string) => invoke<unknown>("join_room", { roomId }),
  logout: () => invoke<void>("logout"),
};

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The request could not be completed. Please try again.";
}
