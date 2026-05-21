"use client";
import { CopilotChat } from "@copilotkit/react-ui";

export default function Page() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", height: "85vh" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>aimock AG-UI repro</h1>
      <p style={{ marginBottom: 16, color: "#555" }}>
        Click the paperclip icon, attach any small file, type a message, and send. Then check{" "}
        <code>fixtures/agui-recorded/</code> — the produced fixture will have{" "}
        <code>match.message: &quot;__NO_USER_MESSAGE__&quot;</code>.
      </p>
      <div style={{ height: "70vh", border: "1px solid #ddd", borderRadius: 8 }}>
        <CopilotChat attachments={{ enabled: true }} />
      </div>
    </main>
  );
}
