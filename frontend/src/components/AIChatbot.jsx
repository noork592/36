import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sparkles,
  X,
  Send,
  Loader2,
  Trash2,
  Plus,
  MessageSquare,
  Bot,
  User as UserIcon,
  Mic,
  MicOff,
  Check,
  AlertTriangle,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

/** Try to init Web Speech API on component mount. Returns null if unsupported. */
function makeRecognizer(onInterim, onFinal, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-IN";
  rec.onresult = (e) => {
    let interim = "";
    let finalText = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (finalText) onFinal(finalText.trim());
    else if (interim) onInterim(interim);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  return rec;
}

export default function AIChatbot() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [listening, setListening] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(null);
  // pendingConfirm = {action_id, tool, args, intent}
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const recRef = useRef(null);

  useEffect(() => {
    if (!open || !user) return;
    (async () => {
      try {
        const { data } = await api.get("/ai/chat/sessions");
        setSessions(data.sessions || []);
      } catch (e) {
        /* silent */
      }
    })();
  }, [open, user]);

  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      const target = viewport || scrollRef.current;
      target.scrollTop = target.scrollHeight;
    }
  }, [messages, streamText]);

  const openSession = async (sid) => {
    if (!sid) {
      setActiveSessionId(null);
      setMessages([]);
      return;
    }
    setLoadingSession(true);
    try {
      const { data } = await api.get(`/ai/chat/sessions/${sid}`);
      setActiveSessionId(sid);
      setMessages(data.messages || []);
      setPendingConfirm(null);
    } catch (e) {
      toast.error("Could not open chat session");
    } finally {
      setLoadingSession(false);
    }
  };

  const newSession = () => {
    setActiveSessionId(null);
    setMessages([]);
    setStreamText("");
    setInput("");
    setPendingConfirm(null);
  };

  const deleteSession = async (sid) => {
    try {
      await api.delete(`/ai/chat/sessions/${sid}`);
      setSessions((prev) => prev.filter((s) => s.id !== sid));
      if (activeSessionId === sid) newSession();
    } catch (e) {
      toast.error("Could not delete chat");
    }
  };

  // ---- Voice input ------------------------------------------------
  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop?.();
      setListening(false);
      return;
    }
    const rec = makeRecognizer(
      // interim: live transcript into the input box
      (text) => setInput(text),
      // final: auto-send as soon as speech is complete
      (finalText) => {
        if (!finalText) return;
        setInput(finalText);
        setListening(false);
        // Small delay to let the user visually confirm the transcript
        // in the input box before it gets cleared by sendText().
        setTimeout(() => {
          sendText(finalText);
        }, 250);
      },
      () => setListening(false)
    );
    if (!rec) {
      toast.error("Voice input not supported in this browser");
      return;
    }
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (e) {
      toast.error("Could not start microphone");
      setListening(false);
    }
  };

  // ---- Core: talk to /api/ai/chat/stream --------------------------
  const streamRequest = async (payload) => {
    const token = localStorage.getItem("foms_token");
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamText("");
    setStreaming(true);
    let sessionIdLocal = activeSessionId;
    let assistantText = "";
    let sawConfirm = false;

    try {
      const resp = await fetch(`${BACKEND_URL}/api/ai/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t.slice(0, 200) || `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payloadStr = line.slice(5).trim();
          if (!payloadStr) continue;
          try {
            const evt = JSON.parse(payloadStr);
            if (evt.type === "session") {
              sessionIdLocal = evt.session_id;
              setActiveSessionId(evt.session_id);
            } else if (evt.type === "tool_call") {
              setMessages((prev) => [
                ...prev,
                {
                  id: `tool-${Date.now()}`,
                  role: "tool_call",
                  tool: evt.tool,
                  args: evt.args,
                  created_at: new Date().toISOString(),
                },
              ]);
            } else if (evt.type === "tool_result") {
              setMessages((prev) => [
                ...prev,
                {
                  id: `res-${Date.now()}`,
                  role: "tool_result",
                  tool: evt.tool,
                  result: evt.result,
                  created_at: new Date().toISOString(),
                },
              ]);
            } else if (evt.type === "confirm") {
              sawConfirm = true;
              setPendingConfirm({
                action_id: evt.action_id,
                tool: evt.tool,
                args: evt.args,
                intent: evt.intent,
              });
            } else if (evt.type === "reply_delta") {
              assistantText += evt.text || "";
              setStreamText(assistantText);
            } else if (evt.type === "done") {
              const finalMsg = {
                id: evt.assistant_message_id || `local-${Date.now()}`,
                role: "assistant",
                content: assistantText,
                created_at: new Date().toISOString(),
              };
              if (assistantText) setMessages((prev) => [...prev, finalMsg]);
              setStreamText("");
            } else if (evt.type === "error") {
              toast.error(evt.message || "AI error");
            }
          } catch {
            /* ignore malformed SSE line */
            void 0;
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") toast.error(String(e.message || e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Refresh session list to pick up title
      try {
        const { data } = await api.get("/ai/chat/sessions");
        setSessions(data.sessions || []);
      } catch (_) {
        void 0;
      }
    }
    return { sawConfirm };
  };

  const sendText = async (text) => {
    const t = (text || "").trim();
    if (!t || streaming) return;
    setInput("");
    setPendingConfirm(null);
    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: t,
        created_at: new Date().toISOString(),
      },
    ]);
    await streamRequest({ session_id: activeSessionId, message: t });
  };

  const sendMessage = () => sendText(input);

  const confirmPending = async () => {
    if (!pendingConfirm || streaming) return;
    const p = pendingConfirm;
    setPendingConfirm(null);
    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: `Confirmed: ${p.intent}`,
        created_at: new Date().toISOString(),
      },
    ]);
    await streamRequest({
      session_id: activeSessionId,
      message: `Confirmed: ${p.intent}`,
      confirm_action_id: p.action_id,
    });
  };

  const cancelPending = async () => {
    if (!pendingConfirm) return;
    const aid = pendingConfirm.action_id;
    setPendingConfirm(null);
    try {
      await api.post("/ai/chat/cancel", { action_id: aid });
    } catch (_) {
      void 0;
    }
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}`,
        role: "assistant",
        content: "OK, cancelled that action.",
        created_at: new Date().toISOString(),
      },
    ]);
  };

  const stopStreaming = () => abortRef.current?.abort?.();

  const suggestions = useMemo(
    () => [
      "Show all pending orders",
      "Ledger balance for AMK Traders",
      "Overdue parties above 30 days",
      "Record ₹5000 payment from AMK Traders",
    ],
    []
  );

  if (!user) return null;

  const supportsSpeech =
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          data-testid="ai-chatbot-fab"
          className="fixed z-[55] bottom-[calc(11rem+env(safe-area-inset-bottom))] right-[calc(1.25rem+env(safe-area-inset-right))] sm:bottom-[calc(6rem+env(safe-area-inset-bottom))] sm:right-[calc(1.5rem+env(safe-area-inset-right))] h-14 w-14 rounded-full bg-gradient-to-br from-[#E65100] to-[#c94300] text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center justify-center border-2 border-white"
          aria-label="Open AI assistant"
        >
          <Sparkles className="w-6 h-6" />
        </button>
      )}

      {open && (
        <div
          data-testid="ai-chatbot-panel"
          className="fixed z-[55] bottom-4 right-4 w-[440px] max-w-[calc(100vw-1.5rem)] h-[680px] max-h-[calc(100vh-1.5rem)] bg-white rounded-lg shadow-2xl border border-slate-300 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 text-white">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-md bg-[#E65100] flex items-center justify-center">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <div className="font-heading font-bold text-sm leading-tight">
                  Factory Agent
                </div>
                <div className="text-[10px] text-slate-400 leading-tight">
                  Ask, or say &quot;record payment&quot;, &quot;create order&quot;, …
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={newSession}
                title="New chat"
                data-testid="ai-chatbot-new-btn"
                className="h-8 w-8 rounded hover:bg-slate-800 flex items-center justify-center"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                data-testid="ai-chatbot-close-btn"
                className="h-8 w-8 rounded hover:bg-slate-800 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {sessions.length > 0 && (
            <div className="border-b border-slate-200 bg-slate-50 max-h-24 overflow-y-auto">
              <div className="flex items-center gap-1 p-2 flex-wrap">
                {sessions.slice(0, 8).map((s) => (
                  <div
                    key={s.id}
                    className={`group flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] cursor-pointer border ${
                      activeSessionId === s.id
                        ? "bg-[#E65100] text-white border-[#E65100]"
                        : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                    }`}
                  >
                    <MessageSquare className="w-3 h-3 shrink-0" />
                    <span
                      className="truncate max-w-[140px]"
                      onClick={() => openSession(s.id)}
                    >
                      {s.title || "Untitled"}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                      className="opacity-60 hover:opacity-100"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <ScrollArea className="flex-1" ref={scrollRef} data-testid="ai-chatbot-scroll">
            <div className="p-4 space-y-3">
              {messages.length === 0 && !streamText && (
                <EmptyState
                  username={user?.username}
                  suggestions={suggestions}
                  onPick={setInput}
                />
              )}
              {loadingSession && (
                <div className="text-center text-xs text-slate-500 py-2">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
                  Loading…
                </div>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} />
              ))}
              {streaming && streamText && (
                <div className="flex gap-2" data-testid="ai-chatbot-msg-stream">
                  <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-[#E65100] text-white">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                  <div className="rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed bg-slate-100 text-slate-900">
                    {streamText}
                    <span className="inline-block w-1.5 h-3.5 bg-slate-400 ml-1 animate-pulse align-middle" />
                  </div>
                </div>
              )}
              {streaming && !streamText && (
                <div className="text-xs text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
                  Thinking…
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Confirmation banner for write actions */}
          {pendingConfirm && (
            <div
              data-testid="ai-chatbot-confirm-banner"
              className="border-t border-amber-300 bg-amber-50 px-3 py-2.5"
            >
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-slate-800 flex-1">
                  <div className="font-bold text-amber-800 uppercase text-[10px] tracking-wider">
                    Confirm this action
                  </div>
                  <div className="mt-0.5 leading-snug">{pendingConfirm.intent}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={confirmPending}
                  disabled={streaming}
                  data-testid="ai-chatbot-confirm-btn"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 px-2.5 text-xs rounded-sm"
                >
                  <Check className="w-3.5 h-3.5 mr-1" /> Confirm
                </Button>
                <Button
                  onClick={cancelPending}
                  disabled={streaming}
                  data-testid="ai-chatbot-cancel-btn"
                  variant="outline"
                  className="h-7 px-2.5 text-xs rounded-sm border-slate-300"
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Input row */}
          <div className="border-t border-slate-200 p-3 bg-white">
            <div className="flex items-center gap-2">
              {supportsSpeech && (
                <Button
                  onClick={toggleMic}
                  disabled={streaming}
                  variant="outline"
                  data-testid="ai-chatbot-mic-btn"
                  title={listening ? "Stop listening" : "Speak"}
                  className={`rounded-sm shrink-0 ${
                    listening
                      ? "border-red-400 text-red-600 bg-red-50 animate-pulse"
                      : "border-slate-300"
                  }`}
                >
                  {listening ? (
                    <MicOff className="w-4 h-4" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </Button>
              )}
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={
                  listening
                    ? "Listening… speak now"
                    : "Ask, or command your factory…"
                }
                disabled={streaming}
                data-testid="ai-chatbot-input"
                className="flex-1 rounded-sm border-slate-300 focus:border-[#E65100] focus:ring-[#E65100]"
              />
              {streaming ? (
                <Button
                  onClick={stopStreaming}
                  data-testid="ai-chatbot-stop-btn"
                  variant="outline"
                  className="rounded-sm"
                >
                  <X className="w-4 h-4" />
                </Button>
              ) : (
                <Button
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  data-testid="ai-chatbot-send-btn"
                  className="bg-[#E65100] hover:bg-[#CC4800] text-white rounded-sm"
                >
                  <Send className="w-4 h-4" />
                </Button>
              )}
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 text-center">
              Powered by GPT · Writes always ask for confirmation.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function EmptyState({ username, suggestions, onPick }) {
  return (
    <div className="text-center py-6">
      <div className="w-12 h-12 rounded-full bg-orange-50 border border-orange-200 flex items-center justify-center mx-auto mb-3">
        <Bot className="w-6 h-6 text-[#E65100]" />
      </div>
      <p className="text-sm font-bold text-slate-900">
        Hi {username || "there"} — I can read AND act on your factory data.
      </p>
      <p className="text-xs text-slate-500 mt-1 leading-relaxed">
        English, हिंदी or Hinglish. Writes need your confirmation.
      </p>
      <div className="mt-4 space-y-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="block w-full text-left text-xs px-3 py-2 rounded border border-slate-200 hover:border-slate-400 hover:bg-slate-50 text-slate-700"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ m }) {
  if (m.role === "tool_call") {
    return (
      <div className="flex gap-2" data-testid="ai-chatbot-msg-toolcall">
        <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-slate-200 text-slate-700">
          <Wrench className="w-3.5 h-3.5" />
        </div>
        <div className="rounded-lg px-3 py-1.5 text-[11px] font-mono bg-slate-50 border border-slate-200 text-slate-600 max-w-[85%]">
          <span className="font-bold text-slate-900">{m.tool}</span>
          {m.args && Object.keys(m.args).length > 0 && (
            <span>
              (
              {Object.entries(m.args)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(", ")}
              )
            </span>
          )}
        </div>
      </div>
    );
  }
  if (m.role === "tool_result") {
    return <ToolResultCard tool={m.tool} result={m.result} />;
  }
  return (
    <div
      className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}
      data-testid={`ai-chatbot-msg-${m.role}`}
    >
      <div
        className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center ${
          m.role === "user"
            ? "bg-slate-200 text-slate-700"
            : "bg-[#E65100] text-white"
        }`}
      >
        {m.role === "user" ? (
          <UserIcon className="w-3.5 h-3.5" />
        ) : (
          <Bot className="w-3.5 h-3.5" />
        )}
      </div>
      <div
        className={`rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed ${
          m.role === "user"
            ? "bg-slate-900 text-white"
            : "bg-slate-100 text-slate-900"
        }`}
      >
        {m.content}
      </div>
    </div>
  );
}

function fmtInr(v) {
  const n = Number(v || 0);
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function ToolResultCard({ tool, result }) {
  if (!result) return null;
  const err = result.ok === false;
  return (
    <div className="ml-9 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 mb-1">
        <Wrench className="w-3 h-3 text-slate-500" />
        <span className="font-bold text-[10px] uppercase tracking-wider text-slate-500">
          {tool}
        </span>
        {err && (
          <span className="text-[10px] font-bold text-red-600">FAILED</span>
        )}
      </div>
      {err && <div className="text-red-700">{result.message}</div>}
      {!err && result.rows && Array.isArray(result.rows) && (
        <div className="max-h-40 overflow-y-auto">
          <div className="text-[10px] text-slate-500 mb-1">
            {result.count ?? result.rows.length} result(s)
          </div>
          <table className="w-full text-[11px] border-collapse">
            <tbody>
              {result.rows.slice(0, 10).map((row, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {Object.entries(row).slice(0, 4).map(([k, v]) => (
                    <td
                      key={k}
                      className="py-0.5 pr-2 align-top text-slate-700"
                    >
                      {typeof v === "number" && k.match(/amount|balance|value/i)
                        ? `₹${fmtInr(v)}`
                        : v ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!err && result.balance !== undefined && (
        <div className="grid grid-cols-2 gap-1">
          <div>
            <div className="text-[10px] uppercase text-slate-500">Balance</div>
            <div className="font-bold text-slate-900">
              ₹{fmtInr(result.balance)} {result.balance_side}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-500">
              Dispatched
            </div>
            <div>₹{fmtInr(result.total_dispatched)}</div>
          </div>
        </div>
      )}
      {!err && result.message && !result.rows && (
        <div className="text-slate-700">{result.message}</div>
      )}
    </div>
  );
}
