import { notFound } from "next/navigation";
import Link from "next/link";
import ProfileForm from "@/components/ProfileForm";
import { PERSONAS } from "@/lib/personas";
import { findPersona, listPersonas } from "@/lib/profiles";
import type { Persona } from "@/lib/types";

const BLANK: Persona = {
  id: "new", name: "", age: 35, blurb: "", lang: "es",
  home: { label: "Casa · San Juan", lat: 18.466, lng: -66.106 }, work: null,
  insurance: "triple-s", email: "demo@example.com", suggested: [],
};

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let persona: Persona | null = BLANK;
  let mode: "new" | "builtin" | "edited" | "custom" = "new";
  if (id !== "new") {
    persona = await findPersona(id);
    if (!persona) notFound();
    const builtIn = PERSONAS.some((p) => p.id === id);
    mode = !builtIn ? "custom" : (await listPersonas()).find((p) => p.id === id)?.edited ? "edited" : "builtin";
  }
  return (
    <main className="page">
      <nav className="page-nav"><Link href="/" className="brand"><span className="brand-mark" aria-hidden>✚</span> CitaYa <span className="brand-pr">PR</span></Link></nav>
      <ProfileForm initial={persona} mode={mode} />
    </main>
  );
}
