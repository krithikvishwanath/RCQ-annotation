"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const C = {
  bg: "#F3F4F6",
  surface: "#FFFFFF",
  bdr: "#D5D8DF",
  ink: "#1C2029",
  inkS: "#4D5567",
  inkM: "#929AAB",
  ac: "#3B6ED5",
  acL: "#E6EDFB",
  ok: "#1A8F62",
  okL: "#E4F6EE",
  dn: "#C73D4D",
  dnL: "#FDE9EB",
};

const serif = 'Georgia, "Times New Roman", serif';
const sans = '"Segoe UI", system-ui, -apple-system, sans-serif';

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    // ignore
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [existing, setExisting] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setLoading] = useState(false);

  useEffect(() => {
    const sessionId = safeGet("clinbench.sessionId");
    const existingName = safeGet("clinbench.name");
    const savedCode = safeGet("clinbench.accessCode");
    if (sessionId && existingName) {
      setExisting({ sessionId, name: existingName });
    }
    if (savedCode) setAccessCode(savedCode);
  }, []);

  async function start() {
    setError("");
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter your name.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, accessCode: accessCode.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to start session.");

      safeSet("clinbench.sessionId", data.sessionId);
      safeSet("clinbench.name", data.name);
      if (accessCode.trim()) safeSet("clinbench.accessCode", accessCode.trim());
      setExisting({ sessionId: data.sessionId, name: data.name });
      router.push("/eval");
    } catch (e) {
      setError(e?.message || "Failed to start.");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    safeRemove("clinbench.sessionId");
    safeRemove("clinbench.name");
    safeRemove("clinbench.accessCode");
    setExisting(null);
    setName("");
    setError("");
  }

  const fld = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${C.bdr}`,
    fontFamily: sans,
    fontSize: 13,
    color: C.ink,
    outline: "none",
  };

  return (
    <div
      style={{
        fontFamily: sans,
        background: C.bg,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: C.surface,
          borderRadius: 14,
          padding: "34px 30px",
          maxWidth: 440,
          width: "100%",
          border: `1px solid ${C.bdr}`,
          boxShadow: "0 2px 16px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: `linear-gradient(135deg,${C.ac},#6B3FA0)`,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 900,
              fontSize: 16,
              marginBottom: 12,
            }}
          >
            Rx
          </div>
          <h1 style={{ fontFamily: serif, fontSize: 22, margin: "0 0 6px", fontWeight: 700 }}>
            Clinical Evaluation Portal
          </h1>
          <p style={{ margin: 0, fontSize: 12, color: C.inkM, lineHeight: 1.5 }}>
            De-identified clinical questions. Ratings are saved automatically as you go.
          </p>
        </div>

        {existing ? (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${C.ok}30`,
              background: C.okL,
              color: C.ok,
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 14,
            }}
          >
            Continue as <b>{existing.name}</b>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button
                onClick={() => router.push("/eval")}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: C.ac,
                  color: "#fff",
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: sans,
                  fontSize: 12,
                }}
              >
                Resume
              </button>
              <button
                onClick={reset}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${C.bdr}`,
                  background: "#fff",
                  color: C.inkS,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: sans,
                  fontSize: 12,
                }}
              >
                Switch
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 3 }}>
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dr. Jane Smith"
            style={fld}
            autoComplete="name"
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 3 }}>
            Access code (if provided)
          </label>
          <input
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="Optional"
            style={fld}
            autoComplete="off"
          />
        </div>

        {error ? (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${C.dn}35`,
              background: C.dnL,
              color: C.dn,
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        ) : null}

        <button
          onClick={start}
          disabled={isLoading}
          style={{
            width: "100%",
            padding: "11px 12px",
            borderRadius: 9,
            border: "none",
            background: isLoading ? C.bdr : C.ac,
            color: "#fff",
            fontWeight: 900,
            fontSize: 13,
            fontFamily: sans,
            cursor: isLoading ? "not-allowed" : "pointer",
          }}
        >
          {isLoading ? "Starting..." : "Start evaluating"}
        </button>

        <div style={{ marginTop: 12, fontSize: 10.5, color: C.inkM, lineHeight: 1.5 }}>
          Keyboard shortcuts: <b>1-4</b> for Likert scores, <b>Y/N</b> for binary, <b>←/→</b> navigation.
        </div>
      </div>
    </div>
  );
}

