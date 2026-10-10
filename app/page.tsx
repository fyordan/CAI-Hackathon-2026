import Link from "next/link";
import { connection } from "next/server";
import { INSURERS } from "@/lib/personas";
import { listPersonas } from "@/lib/profiles";
import { ResetButton } from "@/components/ResetButton";
import { LiveToggle } from "@/components/LiveToggle";

export default async function Home() {
  await connection();
  const personas = await listPersonas();
  return (
    <main className="landing">
      <header className="landing-head">
        <div className="brand"><span className="brand-mark" aria-hidden>✚</span> CitaYa <span className="brand-pr">PR</span></div>
        <span className="head-actions"><LiveToggle /><ResetButton /></span>
      </header>
      <section className="landing-intro">
        <h1>Say what you need once. CitaYa finds the offices and makes the calls.</h1>
        <p>Pick who is booking. Clinics, calls and openings in this demo are simulated.</p>
      </section>
      <ol className="persona-list">
        {personas.map((p) => (
          <li key={p.id} className="persona-row">
            <Link href={`/demo/${p.id}`} className="persona-link" data-testid={`persona-${p.id}`}>
              <span className="persona-avatar" aria-hidden>{p.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</span>
              <span className="persona-main">
                <strong>{p.name}{p.patient ? <span className="for"> for {p.patient.name}</span> : null}</strong>
                {p.need && <span className="persona-need">{p.need}</span>}
                <span className="persona-meta">{p.home.label.split("·").pop()?.trim()} · {INSURERS[p.insurance]?.name} · {p.lang === "en" ? "English" : p.id === "javi" ? "Spanglish" : "Español"}{p.edited ? " · edited" : ""}</span>
              </span>
              <span className="persona-go" aria-hidden>→</span>
            </Link>
            <Link href={`/profile/${p.id}`} className="btn ghost small persona-edit" aria-label={`Edit ${p.name}`} data-testid={`edit-${p.id}`}>Edit</Link>
          </li>
        ))}
      </ol>
      <Link href="/profile/new" className="btn add-persona" data-testid="new-persona">＋ New persona</Link>
      <footer className="landing-foot">
        Hackathon prototype. Not medical advice and not a medical device. Every clinic, phone number and opening is synthetic.
      </footer>
    </main>
  );
}
