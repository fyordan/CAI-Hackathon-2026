"use client";
import { useState } from "react";
export function ResetButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn ghost" disabled={busy} data-testid="reset"
      onClick={async () => { setBusy(true); await fetch("/api/demo/reset", { method: "POST" }); setBusy(false); onDone?.(); }}>
      {busy ? "Resetting…" : "Reset demo"}
    </button>
  );
}
