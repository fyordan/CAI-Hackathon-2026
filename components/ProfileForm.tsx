"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { INSURERS } from "@/lib/personas";
import { nearestTown, TOWNS } from "@/lib/towns";
import type { Lang, Persona, Place } from "@/lib/types";
import type { Pt } from "./PlacePicker";

const PlacePicker = dynamic(() => import("./PlacePicker"), { ssr: false, loading: () => <div className="picker-map" /> });

const townOf = (p: Place) => p.label.split("·").pop()!.trim();
const townPt = (name: string): Place | null => { const tw = TOWNS.find((x) => x[0] === name); return tw ? { label: name, lat: tw[1], lng: tw[2] } : null; };
const PROGRAMS = [...new Set(Object.values(INSURERS).map((i) => i.program))];
const SORTED_TOWNS = [...TOWNS].sort((a, b) => a[0].localeCompare(b[0], "es"));

function placeLabel(kind: "home" | "work", town: string, lang: Lang, patient: string | null) {
  if (kind === "work") return `${lang === "en" ? "Work" : "Trabajo"} · ${town}`;
  if (patient) return `${lang === "en" ? `${patient}'s home` : `Casa de ${patient}`} · ${town}`;
  return `${lang === "en" ? "Home" : "Casa"} · ${town}`;
}

export default function ProfileForm({ initial, mode }: { initial: Persona; mode: "new" | "builtin" | "edited" | "custom" }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [age, setAge] = useState(String(initial.age));
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [email, setEmail] = useState(initial.email);
  const [insurance, setInsurance] = useState(initial.insurance);
  const [caregiver, setCaregiver] = useState(!!initial.patient);
  const [patient, setPatient] = useState(initial.patient ?? { name: "", age: 70, relation: initial.lang === "en" ? "mother" : "madre" });
  const [home, setHome] = useState<Pt & { town: string }>({ ...initial.home, town: townOf(initial.home) });
  const [work, setWork] = useState<(Pt & { town: string }) | null>(initial.work ? { ...initial.work, town: townOf(initial.work) } : null);
  const [placing, setPlacing] = useState<"home" | "work">("home");
  const [need, setNeed] = useState(initial.need ?? "");
  const [ex1, setEx1] = useState(initial.suggested[0] ?? "");
  const [ex2, setEx2] = useState(initial.suggested[1] ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patientFirst = caregiver && patient.name.trim() ? patient.name.trim().split(" ")[0] : null;
  const initials = useMemo(() => name.trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase() || "?", [name]);

  const setTown = (kind: "home" | "work", town: string) => {
    if (kind === "work" && !town) { setWork(null); setPlacing("home"); return; }
    const p = townPt(town);
    if (!p) return;
    if (kind === "home") setHome({ ...p, town }); else setWork({ ...p, town });
    setPlacing(kind);
  };
  const onPick = (p: Pt, kind: "home" | "work") => {
    const town = nearestTown(p.lat, p.lng)[0];
    if (kind === "home") setHome({ ...p, town }); else setWork({ ...p, town });
  };

  const save = async (open: boolean) => {
    setSaving(true);
    setError(null);
    const body = {
      name, age: Number(age), lang, email: email.trim(), insurance, need: need.trim() || undefined,
      patient: caregiver ? { name: patient.name, age: Number(patient.age), relation: patient.relation } : null,
      home: { label: placeLabel("home", home.town, lang, patientFirst), lat: home.lat, lng: home.lng },
      work: work ? { label: placeLabel("work", work.town, lang, null), lat: work.lat, lng: work.lng } : null,
      suggested: [ex1, ex2].map((x) => x.trim()).filter(Boolean),
    };
    const res = await fetch(mode === "new" ? "/api/personas" : `/api/personas/${initial.id}`, { method: mode === "new" ? "POST" : "PUT", body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      const issue = data.error?.[0];
      setError(issue ? `${issue.path?.join(" › ") || "Form"}: ${issue.message}` : "Couldn't save. Is the database running?");
      return;
    }
    router.push(open ? `/demo/${data.id}` : "/");
    router.refresh();
  };
  const remove = async () => {
    await fetch(`/api/personas/${initial.id}`, { method: "DELETE" });
    router.push("/");
    router.refresh();
  };

  return (
    <form className="profile" onSubmit={(e) => { e.preventDefault(); save(false); }} data-testid="profile-form">
      <header className="profile-head">
        <span className="persona-avatar big" aria-hidden>{initials}</span>
        <div>
          <p className="eyebrow">{mode === "new" ? "New persona" : "Edit persona"}</p>
          <h1>{name.trim() || "Unnamed persona"}</h1>
        </div>
      </header>

      <fieldset className="card">
        <legend>Who is booking</legend>
        <div className="grid-2">
          <label className="field">Full name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="off" /></label>
          <label className="field">Age<input type="number" inputMode="numeric" min={0} max={120} value={age} onChange={(e) => setAge(e.target.value)} required /></label>
        </div>
        <div className="grid-2">
          <div className="field" role="radiogroup" aria-label="Language">
            <span>Language</span>
            <div className="segmented">
              {(["es", "en"] as Lang[]).map((l) => (
                <button type="button" key={l} role="radio" aria-checked={lang === l} onClick={() => setLang(l)}>{l === "es" ? "Español" : "English"}</button>
              ))}
            </div>
          </div>
          <label className="field">Email for calendar invites<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" /></label>
        </div>
        <label className="check">
          <input type="checkbox" checked={caregiver} onChange={(e) => setCaregiver(e.target.checked)} />
          <span>Booking for a family member <small>Caregiver mode: the agent calls on the patient&apos;s behalf, and home means the patient&apos;s home.</small></span>
        </label>
        {caregiver && (
          <div className="grid-3">
            <label className="field">Patient&apos;s name<input value={patient.name} onChange={(e) => setPatient({ ...patient, name: e.target.value })} required maxLength={60} /></label>
            <label className="field">Patient&apos;s age<input type="number" min={0} max={120} value={patient.age} onChange={(e) => setPatient({ ...patient, age: Number(e.target.value) })} required /></label>
            <label className="field">Relation to them<input value={patient.relation} onChange={(e) => setPatient({ ...patient, relation: e.target.value })} required maxLength={30} placeholder={lang === "en" ? "father" : "padre"} /></label>
          </div>
        )}
      </fieldset>

      <fieldset className="card">
        <legend>Insurance</legend>
        <label className="field">Plan<select value={insurance} onChange={(e) => setInsurance(e.target.value)}>
          {PROGRAMS.map((pg) => (
            <optgroup key={pg} label={pg}>
              {Object.entries(INSURERS).filter(([, v]) => v.program === pg).map(([id, v]) => <option key={id} value={id}>{v.name}</option>)}
            </optgroup>
          ))}
        </select></label>
        <p className="hint">The agent only shortlists offices that take this plan and never asks for it in chat.</p>
      </fieldset>

      <fieldset className="card">
        <legend>Places</legend>
        <div className="places">
          <div className="places-fields">
            <label className={`field place ${placing === "home" ? "on" : ""}`} onFocus={() => setPlacing("home")}>
              <span><i className="place-dot home" aria-hidden>⌂</i> {caregiver ? "Patient's home" : "Home"}</span>
              <select value={TOWNS.some((x) => x[0] === home.town) ? home.town : ""} onChange={(e) => setTown("home", e.target.value)}>
                {SORTED_TOWNS.map(([n]) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className={`field place ${placing === "work" ? "on" : ""}`} onFocus={() => work && setPlacing("work")}>
              <span><i className="place-dot work" aria-hidden>▣</i> Work</span>
              <select value={work?.town ?? ""} onChange={(e) => setTown("work", e.target.value)}>
                <option value="">No work location</option>
                {SORTED_TOWNS.map(([n]) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <p className="hint">Pick a town, or click the map to place <strong>{placing === "home" ? (caregiver ? "the patient's home" : "home") : "work"}</strong> exactly. Pins can be dragged. Drive times are measured from these points.</p>
          </div>
          <PlacePicker home={home} work={work} active={placing} onPick={onPick} />
        </div>
      </fieldset>

      <fieldset className="card">
        <legend>Demo script</legend>
        <label className="field">What they need <small>shown on the persona list</small><input value={need} onChange={(e) => setNeed(e.target.value)} maxLength={140} placeholder="Dermatologist after 4pm, ≤20 min from home" /></label>
        <label className="field">First message <small>offered as “Try:” in the chat</small><textarea value={ex1} onChange={(e) => setEx1(e.target.value)} rows={3} maxLength={400} placeholder={lang === "en" ? "I need a dermatologist for a rash, weekdays after 4pm." : "Necesito un dermatólogo por un rash, entre semana después de las 4."} /></label>
        <label className="field">Follow-up <small>usually the drive time answer</small><input value={ex2} onChange={(e) => setEx2(e.target.value)} maxLength={400} placeholder={lang === "en" ? "Within 20 minutes of home." : "Veinte minutos de mi casa."} /></label>
      </fieldset>

      {error && <p className="form-error" role="alert">{error}</p>}

      <footer className="profile-actions">
        {mode !== "new" && mode !== "builtin" && !confirmDelete && (
          <button type="button" className="btn ghost danger-text" onClick={() => setConfirmDelete(true)} data-testid="delete-persona">{mode === "custom" ? "Delete persona" : "Restore original"}</button>
        )}
        {confirmDelete && (
          <span className="confirm-inline">
            {mode === "custom" ? "Delete this persona?" : "Discard your edits?"}
            <button type="button" className="btn danger" onClick={remove}>{mode === "custom" ? "Delete" : "Restore"}</button>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
          </span>
        )}
        <span className="spacer" />
        <Link href="/" className="btn ghost">Cancel</Link>
        <button type="submit" className="btn" disabled={saving}>Save</button>
        <button type="button" className="btn primary" disabled={saving} onClick={(e) => { if (e.currentTarget.form?.reportValidity()) save(true); }} data-testid="save-open">Save and open demo</button>
      </footer>
    </form>
  );
}
