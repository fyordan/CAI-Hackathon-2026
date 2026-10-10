"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAY_NAME, formatDate, formatTime, longDate } from "@/lib/dates";
import { effectiveLatest } from "@/lib/brain/rules";
import { INSURERS } from "@/lib/personas";
import { SPECIALTY_LABEL, type Candidate, type Lang, type Persona, type ProviderQuery } from "@/lib/types";
import CallPlayer, { type EventView, type TaskView } from "./CallPlayer";
import Transparency from "./Transparency";
import { StatePill } from "./StatePill";
import { hoursOn } from "./format";
import { t } from "./i18n";
import { useVoice } from "./useVoice";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="map" /> });

type Msg = { role: "user" | "assistant" | "system"; text: string; at: string; kind?: string };
interface Snapshot {
  request: { id: string; persona_id: string; query: ProviderQuery; status: string; messages: Msg[]; shortlist: Candidate[]; expecting: string | null };
  tasks: TaskView[];
  events: EventView[];
  appointment: null | { id: string; provider_id: string; provider_name: string; address: string; phone: string; starts_at: string; status: string; previous_starts_at: string | null; calendar_seq: number };
  calendar: null | { attendee: string; status: string; sequence: number; delivery: string; title: string; updated_at: string };
  notifications: { id: number; kind: string; text: string }[];
  virtual_now: string;
  calendar_mode: string;
}
type Tab = "chat" | "map" | "list" | "calls" | "appt";

function parseSSE(buf: string) {
  const out: { event: string; data: string }[] = [];
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const p of parts) {
    let event = "message", data = "";
    for (const line of p.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) out.push({ event, data });
  }
  return { out, rest };
}

export default function Workspace({ persona }: { persona: Persona }) {
  const lang: Lang = persona.lang;
  const [reqId, setReqId] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [liveQuery, setLiveQuery] = useState<ProviderQuery | null>(null);
  const [liveList, setLiveList] = useState<Candidate[] | null>(null);
  const [pending, setPending] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [panel, setPanel] = useState<"list" | "calls" | "appt">("list");
  const [hovered, setHovered] = useState<string | null>(null);
  const [player, setPlayer] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<{ reply: string; said: string } | null>(null);
  const [showReal, setShowReal] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; kind: string; text: string }[]>([]);
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);
  voiceOnRef.current = voiceOn;
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set());
  const seenNotes = useRef<number>(-1);
  const autoOpened = useRef<Set<string>>(new Set());
  const msgEnd = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { boardRef.current?.scrollTo({ top: 0 }); }, [panel]);

  // create (or resume) a request for this persona
  useEffect(() => {
    const url = new URL(window.location.href);
    const existing = url.searchParams.get("r");
    if (existing) { setReqId(existing); return; }
    fetch("/api/requests", { method: "POST", body: JSON.stringify({ persona: persona.id }) })
      .then((r) => r.json())
      .then(({ id }) => { url.searchParams.set("r", id); window.history.replaceState(null, "", url); setReqId(id); });
  }, [persona.id]);

  // live state stream
  useEffect(() => {
    if (!reqId) return;
    const es = new EventSource(`/api/requests/${reqId}/stream`);
    es.onmessage = (e) => setSnap(JSON.parse(e.data));
    return () => es.close();
  }, [reqId]);

  // toasts from notifications
  useEffect(() => {
    if (!snap) return;
    const notes = snap.notifications;
    if (seenNotes.current === -1) { seenNotes.current = notes.length ? notes[notes.length - 1].id : 0; return; }
    const fresh = notes.filter((n) => n.id > seenNotes.current);
    if (fresh.length) {
      seenNotes.current = fresh[fresh.length - 1].id;
      setToasts((x) => [...x, ...fresh]);
      for (const f of fresh) setTimeout(() => setToasts((x) => x.filter((y) => y.id !== f.id)), 9000);
      if (fresh.some((f) => ["booked", "rebooked", "cancelled"].includes(f.kind))) setPanel("appt");
    }
  }, [snap]);

  // auto-open the player when a call with rendered audio starts ringing
  useEffect(() => {
    if (!snap) return;
    for (const tk of snap.tasks) {
      if (tk.audio && tk.audio_at && !autoOpened.current.has(tk.id) && Date.parse(tk.audio_at) <= Date.now() + 500 && !["COMPLETED", "GAVE_UP"].includes(tk.state)) {
        autoOpened.current.add(tk.id);
        setPlayer(tk.id);
        setPanel("calls");
      }
    }
  }, [snap]);

  const query = liveQuery ?? snap?.request.query ?? null;
  const shortlist = liveList ?? snap?.request.shortlist ?? [];
  const messages = pending.length ? pending : snap?.request.messages ?? [];
  useEffect(() => { msgEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length, pending]);

  const included = shortlist.filter((c) => c.included);
  const calling = (snap?.tasks.length ?? 0) > 0;
  const nextSuggestion = persona.suggested[(snap?.request.messages ?? []).filter((m) => m.role === "user").length];
  const appt = snap?.appointment ?? null;
  const status = snap?.request.status ?? "drafting";

  const send = useCallback(async (text: string) => {
    if (!reqId || !text.trim() || busy) return;
    setBusy(true);
    setDraft("");
    const base = snap?.request.messages ?? [];
    const now = new Date().toISOString();
    let reply = "";
    let replyLang: Lang = lang;
    setPending([...base, { role: "user", text, at: now }, { role: "assistant", text: "…", at: now }]);
    const res = await fetch(`/api/requests/${reqId}/chat`, { method: "POST", body: JSON.stringify({ text }) });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { out, rest } = parseSSE(buf);
      buf = rest;
      for (const { event, data } of out) {
        const d = JSON.parse(data);
        if (event === "meta" && d.lang) replyLang = d.lang;
        if (event === "patch") {
          setLiveQuery(d.query);
          const keys = Object.keys(d.patch);
          setFreshKeys(new Set(keys));
        }
        if (event === "shortlist") setLiveList(d);
        if (event === "token") { reply += d; setPending([...base, { role: "user", text, at: now }, { role: "assistant", text: reply, at: now }]); }
        if (event === "emergency") { setEmergency({ reply: d.reply, said: text }); setPending([...base, { role: "user", text, at: now }, { role: "assistant", text: d.reply, at: now, kind: "emergency" }]); }
        if (event === "done" && d.action === "search") { setPanel("list"); }
        if (event === "done" && d.action === "call") { setPanel("calls"); setTab("calls"); }
        if (event === "done" && voiceOnRef.current) speakRef.current(reply, replyLang);
      }
    }
    setBusy(false);
    setTimeout(() => setFreshKeys(new Set()), 1500);
  }, [reqId, busy, snap]);

  // drop local overrides once the server snapshot has caught up
  useEffect(() => {
    if (busy || !snap) return;
    if (pending.length && snap.request.messages.length >= pending.length) setPending([]);
    if (liveQuery && JSON.stringify(snap.request.query) === JSON.stringify(liveQuery)) setLiveQuery(null);
    if (liveList && snap.request.shortlist.length === liveList.length) setLiveList(null);
  }, [snap, busy, pending.length, liveQuery, liveList]);

  const startCalls = async () => {
    if (!reqId) return;
    await fetch(`/api/requests/${reqId}/calls`, { method: "POST" });
    setPanel("calls");
    setTab("calls");
  };
  const fastForward = async () => {
    if (!reqId) return;
    await fetch("/api/demo/fast-forward", { method: "POST", body: JSON.stringify({ requestId: reqId, hours: 72 }) });
  };
  const cancel = async () => {
    if (!reqId) return;
    setConfirmCancel(false);
    await fetch(`/api/requests/${reqId}/cancel`, { method: "POST" });
    setPanel("calls");
  };
  const reset = async () => {
    await fetch("/api/demo/reset", { method: "POST" });
    window.location.href = `/demo/${persona.id}`;
  };

  const speakRef = useRef<(text: string, l: Lang) => void>(() => {});
  const voice = useVoice({ lang, onText: (text) => { setVoiceOn(true); voiceOnRef.current = true; sendRef.current(text); } });
  speakRef.current = voice.speak;
  const sendRef = useRef(send);
  sendRef.current = send;
  const listening = voice.mic === "listening";

  const playerTask = snap?.tasks.find((x) => x.id === player) ?? null;
  const vnow = snap ? new Date(snap.virtual_now) : null;
  const clock = vnow ? `${formatDate(new Date(vnow.getTime() - 4 * 3600_000).toISOString().slice(0, 10), lang)} · ${formatTime(new Date(vnow.getTime() - 4 * 3600_000).toISOString().slice(11, 16))}` : "";
  const outcome = (tk: TaskView) => {
    const ev = snap?.events.filter((e) => e.call_id === tk.id && e.to_state && e.to_state !== "COMPLETED") ?? [];
    return tk.state === "COMPLETED" ? ev[ev.length - 1]?.to_state ?? tk.state : tk.state;
  };
  const lastLine = (tk: TaskView) => {
    const ev = snap?.events.filter((e) => e.call_id === tk.id && e.text) ?? [];
    return ev[ev.length - 1];
  };
  const bookCalls = snap?.tasks.filter((x) => x.purpose === "book") ?? [];
  const otherCalls = snap?.tasks.filter((x) => x.purpose !== "book") ?? [];
  const tally = useMemo(() => {
    const o = bookCalls.map(outcome);
    return { c: bookCalls.filter((tk) => snap?.events.some((e) => e.call_id === tk.id && e.to_state === "HUMAN")).length, b: o.filter((x) => x === "BOOKED").length, w: o.filter((x) => x === "WAITLISTED").length, g: o.filter((x) => x === "GAVE_UP").length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap]);

  return (
    <div className="ws" data-tab={tab}>
      <header className="ws-head">
        <a href="/" className="brand small"><span className="brand-mark" aria-hidden>✚</span> CitaYa</a>
        <div className="who">
          <strong>{persona.name}</strong>
          <span>{persona.patient ? `${t(lang, "patientFor")} ${persona.patient.name} · ` : ""}{persona.home.label.split("·").pop()?.trim()} · {INSURERS[persona.insurance]?.name}</span>
        </div>
        <div className="head-actions">
          <span className="clock" title={t(lang, "demoTime")} data-testid="clock">{clock}</span>
          {appt?.status === "booked" && <button className="btn" onClick={fastForward} data-testid="fast-forward">⏩ <span className="hide-sm">{t(lang, "ff")}</span><span className="show-sm">+3d</span></button>}
          <a className="btn ghost hide-sm" href={`/profile/${persona.id}`} data-testid="profile">{t(lang, "profile")}</a>
          <button className="btn ghost" onClick={() => setShowReal(true)} data-testid="whats-real">{t(lang, "real")}</button>
          <button className="btn ghost hide-sm" onClick={reset}>{t(lang, "reset")}</button>
        </div>
      </header>

      <QueryBar query={query} expecting={snap?.request.expecting ?? null} lang={lang} persona={persona} fresh={freshKeys} />

      <section className="pane pane-chat" data-pane="chat">
        <div className="messages" data-testid="messages">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role} ${m.kind === "emergency" ? "emergency" : ""}`}>{m.text}</div>
          ))}
          {!calling && status === "ready" && included.length > 0 && (
            <div className="msg-cta show-sm-flex">
              <button className="btn primary" onClick={startCalls} data-testid="call-all">📞 {t(lang, "callAll", { n: Math.min(5, included.length) })}</button>
            </div>
          )}
          <div ref={msgEnd} />
        </div>
        {/* hint the line for the NEXT turn (by count, not exact text: spoken messages never match word for word) */}
        {!calling && nextSuggestion && (
          <div className="suggest">
            <span>{t(lang, "try")}</span>
            <button className="suggestion" onClick={() => send(nextSuggestion)} disabled={busy}>“{nextSuggestion}”</button>
          </div>
        )}
        {voice.error && <div className="mic-error" role="alert" onClick={voice.clearError} data-testid="mic-error">{voice.error}</div>}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
          <button type="button" className={`mic ${voice.mic !== "idle" ? "on" : ""}`} onClick={voice.toggle} disabled={busy || voice.mic === "transcribing" || voice.mic === "requesting"}
            aria-label={t(lang, "talk")} title={t(lang, "talk")} data-testid="mic" style={listening ? { boxShadow: `0 0 0 ${3 + voice.level * 10}px rgba(220, 38, 38, .25)` } : undefined}>
            {voice.mic === "transcribing" || voice.mic === "requesting" ? <Icon d={I.dots} /> : listening ? <Icon d={I.stop} /> : <Icon d={I.mic} />}
          </button>
          <button type="button" className={`mic ${voiceOn ? "on" : ""}`} onClick={() => { if (voiceOn) voice.stopSpeaking(); setVoiceOn(!voiceOn); }}
            aria-label={t(lang, "voiceReplies")} title={t(lang, "voiceReplies")} aria-pressed={voiceOn} data-testid="voice-toggle"><Icon d={voiceOn ? I.speaker : I.muted} /></button>
          <textarea value={draft} rows={1} placeholder={voice.mic === "transcribing" ? t(lang, "transcribing") : listening ? t(lang, "listening") : t(lang, "type")} onChange={(e) => setDraft(e.target.value)} data-testid="composer"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }} />
          <button className="btn primary" disabled={busy || !draft.trim()} data-testid="send">{t(lang, "send")}</button>
        </form>
      </section>

      <section className="pane pane-map" data-pane="map">
        <MapView persona={persona} candidates={shortlist} hovered={hovered} onHover={setHovered} lang={lang} booked={appt?.status === "booked" ? appt.provider_id : null} />
        <div className="map-legend">
          <span><i className="lg in" /> {lang === "es" ? "Cumple" : "Fits"}</span>
          <span><i className="lg out" /> {lang === "es" ? "No cumple" : "Doesn't fit"}</span>
        </div>
      </section>

      <section className="pane pane-board" data-pane="board">
        <div className="board-tabs" role="tablist">
          <button role="tab" aria-selected={panel === "list"} onClick={() => setPanel("list")}>{t(lang, "list")} {included.length > 0 && <b>{included.length}</b>}</button>
          <button role="tab" aria-selected={panel === "calls"} onClick={() => setPanel("calls")} data-testid="tab-calls">{t(lang, "calls")} {(snap?.tasks.length ?? 0) > 0 && <b>{snap!.tasks.length}</b>}</button>
          <button role="tab" aria-selected={panel === "appt"} onClick={() => setPanel("appt")} data-testid="tab-appt">{t(lang, "appt")} {appt?.status === "booked" && <b>✓</b>}</button>
        </div>
        <div className="board-body" ref={boardRef}>
          {panel === "list" && (
            <ShortList list={shortlist} lang={lang} query={query} hovered={hovered} onHover={setHovered} canCall={!calling && status === "ready"} onCall={startCalls} />
          )}
          {panel === "calls" && (
            <div className="calls" data-testid="calls">
              {!snap?.tasks.length && <p className="empty">{t(lang, "noCalls")}</p>}
              {bookCalls.length > 0 && <div className="calls-summary">{t(lang, "summary", tally)}</div>}
              {[...otherCalls.slice().reverse(), ...bookCalls].map((tk) => {
                const last = lastLine(tk);
                const oc = outcome(tk);
                return (
                  <article key={tk.id} className={`call ${oc === "BOOKED" || oc === "CANCELLED" ? "won" : ""}`} data-testid="call-card" data-outcome={oc}>
                    <div className="call-top">
                      <strong>{tk.purpose !== "book" && <span className="call-purpose">{tk.purpose === "rebook" ? (lang === "es" ? "Mover · " : "Move · ") : (lang === "es" ? "Cancelar · " : "Cancel · ")}</span>}{tk.provider_name}</strong>
                      <StatePill state={tk.state} lang={lang} outcome={oc} />
                    </div>
                    <div className="call-line">{last ? (last.speaker && last.speaker !== "system" ? `${last.speaker === "agent" ? "CitaYa" : lang === "es" ? "Oficina" : "Office"}: ` : "") + last.text : "…"}</div>
                    <div className="call-foot">
                      <span>{tk.phone}{tk.attempt > 1 ? ` · ${lang === "es" ? "intento" : "attempt"} ${tk.attempt}` : ""}</span>
                      {(tk.audio || snap?.events.some((e) => e.call_id === tk.id && e.speaker === "office")) && (
                        <button className="btn small" onClick={() => setPlayer(tk.id)} data-testid="listen">{tk.audio ? "🔊 " + t(lang, "listen") : (lang === "es" ? "Transcripción" : "Transcript")}</button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {panel === "appt" && (
            <Booking snap={snap} lang={lang} persona={persona} reqId={reqId} onCancel={() => setConfirmCancel(true)} />
          )}
        </div>
      </section>

      {playerTask && (
        <CallPlayer key={playerTask.id} task={playerTask} events={snap?.events ?? []} lang={lang} onClose={() => setPlayer(null)} />
      )}

      <nav className="tabbar" aria-label="Sections">
        {(["chat", "map", "list", "calls", "appt"] as Tab[]).map((x) => (
          <button key={x} aria-selected={tab === x} data-testid={`m-${x}`} onClick={() => { setTab(x); if (x === "list" || x === "calls" || x === "appt") setPanel(x); }}>
            <span aria-hidden>{{ chat: "💬", map: "🗺", list: "☰", calls: "📞", appt: "📅" }[x]}</span>
            {t(lang, x === "appt" ? "appt" : x)}
            {x === "list" && included.length > 0 && <b>{included.length}</b>}
            {x === "appt" && appt?.status === "booked" && <b>✓</b>}
          </button>
        ))}
      </nav>

      <div className="toasts" aria-live="polite">
        {toasts.map((n) => <div key={n.id} className={`toast ${n.kind}`} data-testid={`toast-${n.kind}`}>{n.text}</div>)}
      </div>

      {emergency && (
        <div className="emergency-wrap" role="alertdialog" data-testid="emergency">
          <div className="emergency">
            <h2>⚠ {t(lang, "emergencyTitle")}</h2>
            <p className="said">{t(lang, "youSaid")}: “{emergency.said}”</p>
            <p>{emergency.reply}</p>
            <a className="btn danger big" href="tel:911">📞 {t(lang, "call911")}</a>
            <p className="fine">{lang === "es" ? "CitaYa no diagnostica. La búsqueda y las llamadas quedan detenidas para este mensaje." : "CitaYa doesn't diagnose. Search and calling are stopped for this message."}</p>
            <button className="btn ghost" onClick={() => setEmergency(null)}>{t(lang, "notEmergency")}</button>
          </div>
        </div>
      )}

      {confirmCancel && (
        <div className="drawer-wrap center" onClick={() => setConfirmCancel(false)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>{t(lang, "cancel")}</h3>
            <p>{t(lang, "cancelConfirm")}</p>
            <div className="row"><button className="btn ghost" onClick={() => setConfirmCancel(false)}>{t(lang, "keep")}</button><button className="btn danger" onClick={cancel} data-testid="confirm-cancel">{t(lang, "yesCancel")}</button></div>
          </div>
        </div>
      )}
      {showReal && <Transparency lang={lang} onClose={() => setShowReal(false)} />}
    </div>
  );
}

// ───────────────────────── query bar ─────────────────────────
function QueryBar({ query, expecting, lang, persona, fresh }: { query: ProviderQuery | null; expecting: string | null; lang: Lang; persona: Persona; fresh: Set<string> }) {
  if (!query) return <div className="querybar" />;
  const chips: { key: string; keys: string[]; label: string; sub?: string; strong?: boolean }[] = [];
  if (query.specialty) chips.push({ key: "sp", keys: ["specialty"], label: `${SPECIALTY_LABEL[query.specialty].icon} ${SPECIALTY_LABEL[query.specialty][lang]}`, strong: true });
  if (persona.patient) chips.push({ key: "pt", keys: ["patient_is_requester"], label: `${t(lang, "patientFor")} ${persona.patient.name}` });
  if (query.days_of_week.length) chips.push({ key: "days", keys: ["days_of_week"], label: query.days_of_week.length === 5 ? (lang === "es" ? "Entre semana" : "Weekdays") : query.days_of_week.map((d) => DAY_NAME[d][lang]).join(", ").replace(/^./, (c) => c.toUpperCase()) });
  const latest = effectiveLatest(query);
  if (query.latest_date) chips.push({ key: "dl", keys: ["latest_date", "deadline_label"], label: query.deadline_label ? query.deadline_label.replace(/^./, (c) => c.toUpperCase()) : `${lang === "es" ? "Hasta" : "By"} ${formatDate(query.latest_date, lang)}`, sub: latest ? `${lang === "es" ? "último día" : "last day"} ${formatDate(latest, lang)}` : undefined });
  if (query.asap) chips.push({ key: "asap", keys: ["asap"], label: lang === "es" ? "Lo antes posible" : "Earliest opening" });
  if (query.time_windows.length) chips.push({ key: "tw", keys: ["time_windows"], label: query.time_windows.map((w) => `${formatTime(w.start).replace(":00", "")}–${formatTime(w.end).replace(":00", "")}`).join(lang === "es" ? " o " : " or ") });
  if (query.max_drive_min != null) chips.push({ key: "drive", keys: ["max_drive_min", "drive_origins"], label: `≤ ${query.max_drive_min} min`, sub: query.drive_origins.length === 2 ? (lang === "es" ? "de casa o trabajo" : "from home or work") : query.drive_origins[0] === "work" ? t(lang, "fromWork") : t(lang, "fromHome") });
  if (query.insurance) chips.push({ key: "ins", keys: ["insurance"], label: INSURERS[query.insurance]?.name ?? query.insurance, sub: t(lang, "fromProfile") });
  if (query.languages.length) chips.push({ key: "lang", keys: ["languages"], label: query.languages.includes("en") ? (lang === "es" ? "Habla inglés" : "English-speaking") : "Habla español" });
  if (query.wheelchair) chips.push({ key: "wc", keys: ["wheelchair"], label: lang === "es" ? "♿ Acceso silla de ruedas" : "♿ Wheelchair access" });
  const missing: string[] = [];
  if (!query.specialty) missing.push(t(lang, "needSpecialty"));
  else {
    if (!query.latest_date && !query.asap) missing.push(t(lang, "needTiming"));
    if (query.max_drive_min == null) missing.push(t(lang, "needDrive"));
  }
  return (
    <div className="querybar" data-testid="querybar">
      <div className="chips">
        {chips.map((c) => (
          <span key={c.key + c.label} className={`chip ${c.strong ? "strong" : ""} ${c.keys.some((k) => fresh.has(k)) ? "fresh" : ""}`} data-testid={`chip-${c.key}`}>
            {c.label}{c.sub && <small>{c.sub}</small>}
          </span>
        ))}
        {missing.map((m, i) => <span key={m} className={`chip missing ${i === 0 && expecting ? "asking" : ""}`}>{m}</span>)}
      </div>
    </div>
  );
}

// ───────────────────────── shortlist ─────────────────────────
function ShortList({ list, lang, query, hovered, onHover, canCall, onCall }: { list: Candidate[]; lang: Lang; query: ProviderQuery | null; hovered: string | null; onHover: (id: string | null) => void; canCall: boolean; onCall: () => void }) {
  const inc = list.filter((c) => c.included);
  const out = list.filter((c) => !c.included);
  if (!list.length) return <p className="empty">{t(lang, "emptyList")}</p>;
  return (
    <div className="shortlist" data-testid="shortlist">
      {!inc.length && <p className="empty">{lang === "es" ? "Ninguna oficina cumple todavía. Prueba con más minutos de manejo u otros días." : "No office fits yet. Try a longer drive or other days."}</p>}
      {inc.length > 0 && <ol>
        {inc.map((c) => (
          <li key={c.id} className={`cand ${hovered === c.id ? "hover" : ""} ${c.rank! > 5 ? "beyond" : ""}`} onMouseEnter={() => onHover(c.id)} onMouseLeave={() => onHover(null)} data-testid="candidate">
            <span className="rank">{c.rank}</span>
            <div className="cand-body">
              <div className="cand-top"><strong>{c.name}</strong><span className="cand-town">{c.municipio}</span></div>
              <div className="cand-drive">
                {c.drive_home_min != null && <span className={c.best_origin === "home" ? "best" : ""}><span aria-hidden>⌂</span> {c.drive_home_min} min <span className="sr-only">{t(lang, "fromHome")}</span></span>}
                {c.drive_work_min != null && <span className={c.best_origin === "work" ? "best" : ""}><span aria-hidden>▣</span> {c.drive_work_min} min <span className="sr-only">{t(lang, "fromWork")}</span></span>}
              </div>
              <div className="cand-meta">{hoursOn(c.hours, query?.days_of_week ?? [], lang)} · {c.languages.map((l) => l.toUpperCase()).join("/")}{c.wheelchair ? " · ♿" : ""} · {c.phone}</div>
            </div>
          </li>
        ))}
      </ol>}
      {out.length > 0 && (
        <details className="excluded">
          <summary>{t(lang, "excluded", { n: out.length })}</summary>
          <ul>{out.map((c) => <li key={c.id}><span>{c.name}</span><em>{c.excluded_reason}</em></li>)}</ul>
        </details>
      )}
      {canCall && inc.length > 0 && <div className="sticky-cta"><button className="btn primary wide" onClick={onCall} data-testid="call-all">📞 {t(lang, "callAll", { n: Math.min(5, inc.length) })}</button></div>}
    </div>
  );
}

// ───────────────────────── booking ─────────────────────────
function Booking({ snap, lang, persona, reqId, onCancel }: { snap: Snapshot | null; lang: Lang; persona: Persona; reqId: string | null; onCancel: () => void }) {
  const a = snap?.appointment;
  if (!a) return <p className="empty">{t(lang, "noAppt")}</p>;
  const cal = snap!.calendar;
  const cancelled = a.status === "cancelled";
  return (
    <div className={`booking ${cancelled ? "cancelled" : ""}`} data-testid="booking" data-status={a.status}>
      <div className="booking-head">
        <span className="booking-mark" aria-hidden>{cancelled ? "✕" : "✓"}</span>
        <div>
          <div className="booking-k">{cancelled ? t(lang, "cancelledT") : t(lang, "booked")}</div>
          <div className="booking-when" data-testid="booking-when">{longDate(a.starts_at, lang).replace(/^el /, "").replace(/^./, (c) => c.toUpperCase())}</div>
          {a.previous_starts_at && <div className="booking-prev">{t(lang, "previously")}: <s>{longDate(a.previous_starts_at, lang).replace(/^el /, "")}</s></div>}
        </div>
      </div>
      <dl className="booking-facts">
        <div><dt>{lang === "es" ? "Oficina" : "Office"}</dt><dd>{a.provider_name}</dd></div>
        <div><dt>{lang === "es" ? "Dirección" : "Address"}</dt><dd>{a.address}</dd></div>
        <div><dt>{lang === "es" ? "Teléfono" : "Phone"}</dt><dd>{a.phone}</dd></div>
        <div><dt>{lang === "es" ? "Paciente" : "Patient"}</dt><dd>{persona.patient?.name ?? persona.name}</dd></div>
      </dl>
      {cal && (
        <div className="invite">
          <div className="invite-k">📅 {t(lang, "invite")}</div>
          <p>{cancelled
            ? (lang === "es" ? `Cancelación lista para ${cal.attendee} (versión ${cal.sequence}).` : `Cancellation ready for ${cal.attendee} (version ${cal.sequence}).`)
            : (lang === "es" ? `Para ${cal.attendee}. En este demo no se envía email.` : `For ${cal.attendee}. No email is sent in this demo.`)}</p>
          <a className="btn" href={`/api/requests/${reqId}/ics`} data-testid="ics">{t(lang, "downloadIcs")}</a>
        </div>
      )}
      {!cancelled && (
        <>
          <div className="watch"><span className="dot-live" aria-hidden /> {t(lang, "watch")}</div>
          <button className="btn ghost danger-text" onClick={onCancel} data-testid="cancel">{t(lang, "cancel")}</button>
        </>
      )}
    </div>
  );
}

// ───────────────────────── icons ─────────────────────────
const I = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  stop: "M7 7h10v10H7z",
  dots: "M6 12h.01M12 12h.01M18 12h.01",
  speaker: "M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  muted: "M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6",
};
function Icon({ d }: { d: string }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
}
