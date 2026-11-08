import { SpaceRooms } from "./SpaceRooms";
import { Fragment, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { api, desktopAvailable, errorText } from "./api";
import type { AppStatus, ChatMessage, RoomSummary } from "./api";

type Phase = "starting" | "signed-out" | "signed-in";
const signedOut: AppStatus = { authenticated: false, syncing: false };

function messageTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messageDay(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function encryptionKnown(room: RoomSummary): boolean {
  return room.encryption_known ?? room.encryptionKnown ?? false;
}

function encryptionLabel(room: RoomSummary): string {
  if (room.isSpace) return "Space";
  return !encryptionKnown(room)
    ? "Checking encryption"
    : room.encrypted
      ? "Encrypted"
      : "Not encrypted";
}

function initials(name: string): string {
  return name
    .replace(/^[@#!]/, "")
    .slice(0, 2)
    .toUpperCase();
}

function messageDateTime(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("starting");
  const [status, setStatus] = useState<AppStatus>(signedOut);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesRoomId, setMessagesRoomId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [homeserver, setHomeserver] = useState("https://matrix.org");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [joinTarget, setJoinTarget] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMethod, setLoginMethod] = useState<"password" | "sso">("sso");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useRef(0);
  const selectedId = useRef("");
  const timelineRequest = useRef(0);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followTimeline = useRef(true);
  const pendingSends = useRef<
    Record<string, { body: string; transactionId: string }>
  >({});
  const desktop = desktopAvailable();
  selectedId.current = selectedRoomId;
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const draft = drafts[selectedRoomId] ?? "";
  const visibleMessages = messagesRoomId === selectedRoomId ? messages : [];
  const filteredRooms = rooms.filter((room) =>
    `${room.name} ${room.id}`
      .toLocaleLowerCase()
      .includes(roomFilter.trim().toLocaleLowerCase()),
  );

  function clearAccount() {
    setStatus(signedOut);
    setRooms([]);
    setSelectedRoomId("");
    selectedId.current = "";
    setMessages([]);
    setMessagesRoomId("");
    setDrafts({});
    pendingSends.current = {};
    setJoinTarget("");
    setRoomFilter("");
    setPassword("");
    setRecoveryKey("");
    setRecoveryNotice("");
    setRecoveryBusy(false);
    setSendBusy(false);
    setJoinBusy(false);
    setLoginBusy(false);
    setCancelBusy(false);
    setLoadingMessages(false);
    setSyncError("");
    setNotice("");
    setPhase("signed-out");
  }

  useEffect(() => {
    let active = true;
    const epoch = generation.current;
    if (!desktop) {
      setPhase("signed-out");
      return;
    }
    void api
      .status()
      .then((next) => {
        if (!active || epoch !== generation.current) return;
        setStatus(next);
        setPhase(next.authenticated ? "signed-in" : "signed-out");
        if (next.error) setError(next.error);
      })
      .catch((failure: unknown) => {
        if (!active || epoch !== generation.current) return;
        setError(errorText(failure));
        setPhase("signed-out");
      });
    return () => {
      active = false;
    };
  }, [desktop]);

  // One polling cycle at a time. Session generations discard work from old accounts.
  useEffect(() => {
    if (phase !== "signed-in") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    const current = () => active && epoch === generation.current;
    const refresh = async () => {
      try {
        const nextStatus = await api.status();
        if (!current()) return;
        if (!nextStatus.authenticated) {
          generation.current++;
          clearAccount();
          setError(
            nextStatus.error ??
              "Your session ended. Sign in again to continue.",
          );
          return;
        }
        setStatus(nextStatus);
        const nextRooms = await api.rooms();
        if (!current()) return;
        setRooms(nextRooms);
        if (!selectedId.current) {
          const first =
            nextRooms.find((room) => room.joined && !room.isSpace) ??
            nextRooms[0];
          if (first) setSelectedRoomId(first.id);
        } else if (!nextRooms.some((room) => room.id === selectedId.current)) {
          setSelectedRoomId("");
          setMessages([]);
        }
        const roomId = selectedId.current;
        if (
          roomId &&
          nextRooms.some(
            (room) => room.id === roomId && room.joined && !room.isSpace,
          )
        ) {
          const request = ++timelineRequest.current;
          const nextMessages = await api.messages(roomId);
          if (
            current() &&
            roomId === selectedId.current &&
            request === timelineRequest.current
          ) {
            setMessages(nextMessages);
            setMessagesRoomId(roomId);
            setLoadingMessages(false);
          }
        }
        if (current()) setSyncError("");
      } catch (failure: unknown) {
        if (current()) setSyncError(errorText(failure));
      } finally {
        if (current())
          timer = setTimeout(() => {
            void refresh();
          }, 3000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [phase, refreshToken]);

  useEffect(() => {
    const roomId = selectedRoomId;
    setMessages([]);
    setMessagesRoomId("");
    setNotice("");
    followTimeline.current = true;
    if (
      !roomId ||
      phase !== "signed-in" ||
      !selectedRoom?.joined ||
      selectedRoom.isSpace
    ) {
      setLoadingMessages(false);
      return;
    }
    let active = true;
    const epoch = generation.current;
    const request = ++timelineRequest.current;
    setLoadingMessages(true);
    void api
      .messages(roomId)
      .then((next) => {
        if (
          !active ||
          epoch !== generation.current ||
          roomId !== selectedId.current ||
          request !== timelineRequest.current
        )
          return;
        setMessages(next);
        setMessagesRoomId(roomId);
      })
      .catch((failure: unknown) => {
        if (
          active &&
          epoch === generation.current &&
          roomId === selectedId.current
        )
          setError(errorText(failure));
      })
      .finally(() => {
        if (
          active &&
          epoch === generation.current &&
          roomId === selectedId.current
        )
          setLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [selectedRoomId, selectedRoom?.joined, selectedRoom?.isSpace, phase]);

  useEffect(() => {
    if (followTimeline.current && scrollArea.current) {
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
    }
  }, [messages]);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginBusy || !desktop) return;
    const secret = password;
    setPassword("");
    setLoginBusy(true);
    setLoginMethod("password");
    setError("");
    const epoch = ++generation.current;
    try {
      await api.login(homeserver.trim(), username.trim(), secret);
      const next = await api.status();
      if (epoch !== generation.current) return;
      if (!next.authenticated)
        throw new Error(
          next.error ?? "Sign-in did not complete. Please try again.",
        );
      setStatus(next);
      setPhase("signed-in");
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setLoginBusy(false);
    }
  }

  async function loginWithBrowser() {
    if (loginBusy || !desktop || !homeserver.trim()) return;
    const epoch = ++generation.current;
    setLoginBusy(true);
    setLoginMethod("sso");
    setError("");
    setPassword("");
    try {
      await api.loginSso(homeserver.trim());
      const next = await api.status();
      if (epoch !== generation.current) return;
      if (!next.authenticated)
        throw new Error(next.error ?? "Browser sign-in did not complete.");
      setStatus(next);
      setPhase("signed-in");
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setLoginBusy(false);
    }
  }

  async function cancelLogin() {
    if (cancelBusy) return;
    setCancelBusy(true);
    try {
      await api.cancelLogin();
      generation.current++;
      setError("");
      setLoginBusy(false);
      const next = await api.status();
      setStatus(next);
      setPhase(next.authenticated ? "signed-in" : "signed-out");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setCancelBusy(false);
    }
  }

  async function logout() {
    if (sendBusy || joinBusy || recoveryBusy) return;
    const epoch = ++generation.current;
    setPhase("starting");
    setError("");
    try {
      await api.logout();
      if (epoch === generation.current) clearAccount();
    } catch (failure) {
      if (epoch !== generation.current) return;
      setError(errorText(failure));
      try {
        const next = await api.status();
        if (epoch !== generation.current) return;
        setStatus(next);
        setPhase(next.authenticated ? "signed-in" : "signed-out");
      } catch {
        if (epoch === generation.current) clearAccount();
      }
    }
  }

  async function recover(event: FormEvent) {
    event.preventDefault();
    if (recoveryBusy || !recoveryKey.trim()) return;
    const epoch = generation.current;
    const secret = recoveryKey.trim();
    setRecoveryKey("");
    setRecoveryBusy(true);
    setError("");
    setRecoveryNotice("");
    try {
      await api.recover(secret);
      if (epoch !== generation.current) return;
      setRecoveryNotice(
        "Recovery completed. Message keys will become available as the app syncs.",
      );
      setRefreshToken((value) => value + 1);
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setRecoveryBusy(false);
    }
  }

  async function send() {
    const roomId = selectedRoomId;
    const body = draft.trim();
    if (
      !body ||
      !selectedRoom?.joined ||
      selectedRoom.isSpace ||
      !encryptionKnown(selectedRoom) ||
      sendBusy
    )
      return;
    const epoch = generation.current;
    setSendBusy(true);
    setError("");
    setNotice("");
    const previousAttempt = pendingSends.current[roomId];
    const transactionId =
      previousAttempt?.body === body
        ? previousAttempt.transactionId
        : crypto.randomUUID();
    pendingSends.current[roomId] = { body, transactionId };
    try {
      await api.send(roomId, body, transactionId);
      if (epoch !== generation.current) return;
      delete pendingSends.current[roomId];
      setDrafts((previous) => ({ ...previous, [roomId]: "" }));
      if (selectedId.current === roomId) {
        setNotice("Message sent.");
        followTimeline.current = true;
      }
      setRefreshToken((value) => value + 1);
    } catch (failure) {
      if (epoch === generation.current)
        setError(
          `${errorText(failure)} Your draft is kept. You can retry after resolving this.`,
        );
    } finally {
      if (epoch === generation.current) setSendBusy(false);
    }
  }

  async function join(roomId: string) {
    if (joinBusy || !roomId.trim()) return;
    const epoch = generation.current;
    setJoinBusy(true);
    setError("");
    try {
      await api.join(roomId.trim());
      if (epoch !== generation.current) return;
      setJoinTarget("");
      setNotice("Joined. The room will appear after syncing.");
      setRefreshToken((value) => value + 1);
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setJoinBusy(false);
    }
  }

  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <strong>Matrix Client</strong>
          <span className="prototype">Preview</span>
        </div>
        {phase === "signed-in" && (
          <div className="account">
            <span
              title={status.deviceId ? `Device: ${status.deviceId}` : undefined}
            >
              {status.userId}
            </span>
            <span className="connection" role="status">
              {syncError || status.error
                ? "Sync needs attention"
                : status.syncing
                  ? "Syncing"
                  : "Connected"}
            </span>
            <button
              className="secondary"
              onClick={() => {
                void logout();
              }}
              disabled={sendBusy || joinBusy || recoveryBusy}
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      {phase === "signed-in" && (
        <details className="security-panel">
          <summary>
            Encryption setup ·{" "}
            {status.deviceVerified === undefined
              ? "Checking device"
              : status.deviceVerified
                ? "Device verified"
                : "Device not verified"}
          </summary>
          <div className="security-content">
            <div>
              <p>
                <strong>Recovery:</strong>{" "}
                {status.recoveryState || "Checking recovery status"}
              </p>
              <p className="small muted">
                Use the existing recovery key you saved when setting up
                encryption on your Matrix account. Interactive device
                verification is not available in this prototype yet.
              </p>
            </div>
            <form
              onSubmit={(event) => {
                void recover(event);
              }}
            >
              <label htmlFor="recovery-key">Recovery key</label>
              <div className="recovery-input">
                <input
                  id="recovery-key"
                  type="password"
                  value={recoveryKey}
                  onChange={(event) => setRecoveryKey(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={recoveryBusy}
                />
                <button
                  type="submit"
                  disabled={recoveryBusy || !recoveryKey.trim()}
                >
                  {recoveryBusy ? "Recovering…" : "Recover keys"}
                </button>
              </div>
              {recoveryNotice && (
                <p className="small" role="status">
                  {recoveryNotice}
                </p>
              )}
            </form>
          </div>
        </details>
      )}

      {phase === "starting" ? (
        <main className="starting" role="status">
          Opening your session…
        </main>
      ) : phase === "signed-out" ? (
        <main className="login-layout">
          <section className="login-card">
            <h1>Sign in</h1>
            {status.hasSavedSession && (
              <div className="banner warning">
                <p>
                  A saved login could not be restored. Removing it clears this
                  app's local sign-in; keep your recovery key and other client
                  available.
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void logout();
                  }}
                >
                  Remove saved login
                </button>
              </div>
            )}
            <p className="muted">Connect your existing Matrix account.</p>
            {!desktop && (
              <div className="banner error" role="alert">
                Open the Windows app to connect. This browser view cannot access
                the desktop messaging service.
              </div>
            )}
            <label>
              Homeserver URL
              <input
                type="url"
                value={homeserver}
                onChange={(event) => setHomeserver(event.target.value)}
                placeholder="https://matrix.example.org"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                disabled={loginBusy}
              />
            </label>
            <button
              type="button"
              disabled={loginBusy || !desktop || !homeserver.trim()}
              onClick={() => {
                void loginWithBrowser();
              }}
            >
              {loginBusy && loginMethod === "sso"
                ? "Waiting for browser sign-in…"
                : "Sign in with browser"}
            </button>
            {loginBusy && loginMethod === "sso" ? (
              <div className="sso-waiting" role="status">
                <p>Complete sign-in in your browser, then return here.</p>
                <button
                  className="secondary"
                  disabled={cancelBusy}
                  onClick={() => {
                    void cancelLogin();
                  }}
                >
                  {cancelBusy ? "Cancelling…" : "Cancel browser sign-in"}
                </button>
              </div>
            ) : (
              <p className="small muted">
                Recommended for matrix.org. Your account password stays in your
                browser.
              </p>
            )}
            <details className="password-login">
              <summary>Other servers / password login</summary>
              <form
                onSubmit={(event) => {
                  void login(event);
                }}
              >
                <label>
                  Username or Matrix ID
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="@you:example.org"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    disabled={loginBusy}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    disabled={loginBusy}
                  />
                </label>
                <button type="submit" disabled={loginBusy || !desktop}>
                  {loginBusy && loginMethod === "password"
                    ? "Signing in…"
                    : "Sign in with password"}
                </button>
              </form>
            </details>
            <div className="prototype-note">
              <strong>Encrypted history</strong>
              <p>
                After signing in, use Encryption setup to recover your message
                keys. Keep your existing client and recovery key available.
              </p>
            </div>
          </section>
        </main>
      ) : (
        <main className="workspace">
          <aside className="sidebar" aria-label="Rooms">
            <div className="sidebar-title">
              <h1>
                Rooms <span className="room-count">{rooms.length}</span>
              </h1>
              <button
                className="secondary small-button"
                onClick={() => setRefreshToken((value) => value + 1)}
              >
                Refresh
              </button>
            </div>
            <div className="room-search">
              <label className="sr-only" htmlFor="room-search">
                Find a room
              </label>
              <input
                id="room-search"
                type="search"
                placeholder="Find a room"
                value={roomFilter}
                onChange={(event) => setRoomFilter(event.target.value)}
              />
            </div>
            <form
              className="join-form"
              onSubmit={(event) => {
                event.preventDefault();
                void join(joinTarget);
              }}
            >
              <label className="sr-only" htmlFor="join-room">
                Room ID or alias
              </label>
              <input
                id="join-room"
                value={joinTarget}
                onChange={(event) => setJoinTarget(event.target.value)}
                placeholder="#room:example.org"
                spellCheck={false}
                disabled={joinBusy}
              />
              <button type="submit" disabled={joinBusy || !joinTarget.trim()}>
                {joinBusy ? "Joining…" : "Join"}
              </button>
            </form>
            <nav className="room-list" aria-label="Conversations">
              {rooms.length === 0 && (
                <p className="empty-sidebar">
                  No rooms yet. Wait for the first sync or join a room above.
                </p>
              )}
              {rooms.length > 0 && filteredRooms.length === 0 && (
                <p className="empty-sidebar">No rooms match your search.</p>
              )}
              {filteredRooms.map((room) => (
                <button
                  key={room.id}
                  className={`room ${selectedRoomId === room.id ? "selected" : ""}`}
                  aria-current={selectedRoomId === room.id ? "page" : undefined}
                  onClick={() => {
                    setError("");
                    setSelectedRoomId(room.id);
                  }}
                >
                  <span className="room-avatar" aria-hidden="true">
                    {initials(room.name || room.id)}
                  </span>
                  <span className="room-copy">
                    <span className="room-name">{room.name || room.id}</span>
                    <span className="room-detail">
                      {room.joined ? encryptionLabel(room) : "Invitation"}
                    </span>
                  </span>
                </button>
              ))}
            </nav>
            <p className="sidebar-footnote">
              Drafts are kept for this session.
            </p>
          </aside>

          <section
            className="conversation"
            aria-label={
              selectedRoom
                ? `Conversation: ${selectedRoom.name}`
                : "Conversation"
            }
          >
            {selectedRoom ? (
              <>
                <header className="room-header">
                  <div>
                    <h2>{selectedRoom.name || selectedRoom.id}</h2>
                    <p className="room-id">{selectedRoom.id}</p>
                  </div>
                  <span
                    className={`badge ${!encryptionKnown(selectedRoom) ? "pending" : selectedRoom.encrypted ? "" : "warning"}`}
                  >
                    {encryptionLabel(selectedRoom)}
                  </span>
                </header>
                {(syncError || status.error) && (
                  <div className="banner warning" role="status">
                    {syncError || status.error} The app will keep trying to
                    sync.
                  </div>
                )}
                {!selectedRoom.joined ? (
                  <div className="empty-state">
                    <h2>You’re invited</h2>
                    <p>Join this room to read and send messages.</p>
                    <button
                      disabled={joinBusy}
                      onClick={() => {
                        void join(selectedRoom.id);
                      }}
                    >
                      {joinBusy ? "Joining…" : "Accept invitation"}
                    </button>
                  </div>
                ) : selectedRoom.isSpace ? (
                  <SpaceRooms
                    key={selectedRoom.id}
                    id={selectedRoom.id}
                    onOpen={setSelectedRoomId}
                    onJoined={() => setRefreshToken((value) => value + 1)}
                  />
                ) : (
                  <>
                    <div
                      className="timeline"
                      ref={scrollArea}
                      onScroll={() => {
                        const area = scrollArea.current;
                        if (area)
                          followTimeline.current =
                            area.scrollHeight -
                              area.scrollTop -
                              area.clientHeight <
                            100;
                      }}
                      aria-label="Message history"
                      aria-busy={loadingMessages}
                    >
                      {visibleMessages.length === 0 && (
                        <div className="empty-state">
                          <p>
                            {loadingMessages
                              ? "Loading messages…"
                              : "No messages loaded yet. New messages will appear after syncing."}
                          </p>
                        </div>
                      )}
                      {visibleMessages.map((message, index) => (
                        <Fragment key={message.id}>
                          {(index === 0 ||
                            messageDay(message.timestamp) !==
                              messageDay(
                                visibleMessages[index - 1].timestamp,
                              )) && (
                            <div className="date-divider">
                              <span>{messageDay(message.timestamp)}</span>
                            </div>
                          )}
                          <article
                            className={`message ${message.sender === status.userId ? "own" : ""}`}
                          >
                            <div className="message-avatar" aria-hidden="true">
                              {initials(message.sender)}
                            </div>
                            <div className="message-content">
                              <div className="message-heading">
                                <strong>{message.sender}</strong>
                                <time
                                  dateTime={messageDateTime(message.timestamp)}
                                  title={messageDay(message.timestamp)}
                                >
                                  {messageTime(message.timestamp)}
                                </time>
                              </div>
                              <p className="message-body">{message.body}</p>
                              {encryptionKnown(selectedRoom) &&
                                selectedRoom.encrypted &&
                                !message.encrypted && (
                                  <span className="message-warning">
                                    Received without encryption
                                  </span>
                                )}
                            </div>
                          </article>
                        </Fragment>
                      ))}
                    </div>
                    <form
                      className="composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void send();
                      }}
                    >
                      <label className="sr-only" htmlFor="message">
                        Message
                      </label>
                      <textarea
                        id="message"
                        rows={2}
                        value={draft}
                        maxLength={16000}
                        onChange={(event) =>
                          setDrafts((previous) => ({
                            ...previous,
                            [selectedRoomId]: event.target.value,
                          }))
                        }
                        onKeyDown={composerKey}
                        placeholder={`Message ${selectedRoom.name || "this room"}`}
                        disabled={sendBusy}
                      />
                      <div className="composer-footer">
                        <span className="small muted" role="status">
                          {sendBusy
                            ? "Sending…"
                            : !encryptionKnown(selectedRoom)
                              ? "Checking room encryption before sending…"
                              : notice ||
                                "Enter to send · Shift+Enter for a new line"}
                        </span>
                        <button
                          type="submit"
                          disabled={
                            sendBusy ||
                            !draft.trim() ||
                            !encryptionKnown(selectedRoom)
                          }
                        >
                          {sendBusy ? "Sending…" : "Send"}
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </>
            ) : (
              <div className="empty-state">
                <h2>Select a room</h2>
                <p>Choose a conversation or join a room to begin.</p>
                {(syncError || status.error) && (
                  <p className="error-text" role="alert">
                    {syncError || status.error}
                  </p>
                )}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
