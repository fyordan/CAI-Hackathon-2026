import Link from "next/link";
import { INSURERS, PERSONAS } from "@/lib/personas";
import { ResetButton } from "@/components/ResetButton";

const NEED: Record<string, string> = {
  marisol: "Podiatrist on a Thursday before Thanksgiving, ≤30 min from home or work",
  yadira: "Cardiology follow-up for her father, mornings, wheelchair access",
  javi: "Doesn't know which doctor: describes stomach symptoms by voice, weekdays, earliest opening",
  ana: "OB-GYN annual exam with an English-speaking doctor",
};

export default function Home() {
  return (
    <main className="landing">
      <header className="landing-head">
        <div className="brand"><span className="brand-mark" aria-hidden>✚</span> CitaYa <span className="brand-pr">PR</span></div>
        <ResetButton />
      </header>
      <section className="landing-intro">
        <h1>Tell it what you need once. It finds the offices and makes the calls.</h1>
        <p>Pick a demo persona. Each one has a home, a plan and a real-feeling need in Puerto Rico. Calls, clinics and openings in this demo are simulated; the badges in the app say exactly what is real.</p>
      </section>
      <ol className="persona-list">
        {PERSONAS.map((p) => (
          <li key={p.id}>
            <Link href={`/demo/${p.id}`} className="persona-row" data-testid={`persona-${p.id}`}>
              <span className="persona-avatar" aria-hidden>{p.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</span>
              <span className="persona-main">
                <strong>{p.name}{p.patient ? ` for ${p.patient.name}` : ""}</strong>
                <span>{NEED[p.id]}</span>
                <span className="persona-meta">{p.home.label.split("·").pop()?.trim()} · {INSURERS[p.insurance].name} · {p.lang === "en" ? "English" : p.id === "javi" ? "Spanglish" : "Español"}</span>
              </span>
              <span className="persona-go">Load</span>
            </Link>
          </li>
        ))}
      </ol>
      <footer className="landing-foot">
        Hackathon prototype. Not medical advice and not a medical device. Every clinic, phone number and opening is synthetic.
      </footer>
    </main>
  );
}
