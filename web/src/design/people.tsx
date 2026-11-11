import { Link } from "react-router-dom";
import { fmtRelative } from "../format";
import type { PeoplePayload, PersonRole, PersonRow } from "../types";
import { useActions, useRead } from "./data";
import { Button, Empty, Panel, Status, Table } from "./ui";

const LABEL: Record<PersonRole, string> = {
  pending: "Waiting for approval",
  customer: "Customer",
  admin: "Network admin",
  system: "System account",
};

/** Who may sign in to what: website sign-ups kept in the ai Directus (docs/SSO.md). */
export function PeoplePanel() {
  const people = useRead<PeoplePayload>("people", "/directus/ai/people", 30000),
    { perform, pending } = useActions(),
    data = people.data;
  const set = (p: PersonRow, body: { role?: string; status?: string }, title: string, description: string, danger = false) =>
    perform(`/directus/ai/people/${p.id}`, body, {
      method: "patch",
      title,
      description,
      danger,
      success: "Saved",
      refresh: ["people"],
    });
  const notSignedIn = people.error && /sign in/i.test((people.error as Error).message);
  return (
    <Panel
      title="People"
      sub="Admins reach everything. Customers reach the private part of xgold.tech only."
    >
      <div className="panel-body">
        {notSignedIn ? (
          <Empty>
            Sign in to the xGold AI database first, under{" "}
            <Link className="text-link" to="/files">
              Files &amp; storage
            </Link>
            , then come back here.
          </Empty>
        ) : people.error ? (
          <Empty>{(people.error as Error).message}</Empty>
        ) : !data ? (
          <Empty>Loading people…</Empty>
        ) : !data.ready ? (
          <Empty>
            Customer sign-ups aren&apos;t set up yet. Run{" "}
            <code>deploy/ai-members.sql</code> on the server (see{" "}
            <code>docs/SSO.md</code>).
          </Empty>
        ) : data.people.length === 0 ? (
          <Empty>No one has signed in yet.</Empty>
        ) : (
          <Table headers={["Person", "Role", "Last seen", "Actions"]}>
            {data.people.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name || p.email}</strong>
                  {p.name && <div className="muted">{p.email}</div>}
                </td>
                <td>
                  <Status
                    label={p.status === "suspended" ? "Suspended" : LABEL[p.role]}
                    state={
                      p.status === "suspended" ? "down" : p.role === "pending" ? "warn" : p.role === "system" ? "unknown" : "ok"
                    }
                  />
                  {p.role === "admin" && data.dashAllowList && !data.dashAllowList.includes(p.email.toLowerCase()) && (
                    <div className="muted">Not on the dash list (ALLOWED_LOGINS)</div>
                  )}
                </td>
                <td>{p.lastAccess ? fmtRelative(p.lastAccess) : "Never"}</td>
                <td>
                  {p.role === "system" ? (
                    <span className="muted">Managed in Directus</span>
                  ) : p.status === "suspended" ? (
                    <Button disabled={pending} onClick={() => set(p, { status: "active" }, "Restore this account?", `${p.email} keeps the role it had.`)}>
                      Restore
                    </Button>
                  ) : (
                    <div className="head-actions">
                      {p.role !== "customer" && (
                        <Button
                          disabled={pending}
                          onClick={() => set(p, { role: "customer" }, p.role === "pending" ? "Approve this customer?" : "Make this person a customer?", `${p.email} will see the private part of xgold.tech and nothing else.`)}
                        >
                          {p.role === "pending" ? "Approve" : "Make customer"}
                        </Button>
                      )}
                      {p.role !== "admin" && (
                        <Button
                          disabled={pending}
                          onClick={() => set(p, { role: "admin" }, "Make this person a network admin?", `${p.email} will see the private part of xgold.tech. Dash, AppFlowy and the CRM also need their e-mail in the Cloudflare Access group "Admins".`)}
                        >
                          Make admin
                        </Button>
                      )}
                      <Button
                        disabled={pending}
                        onClick={() => set(p, { status: "suspended" }, p.role === "pending" ? "Decline this request?" : "Suspend this account?", `${p.email} will no longer be able to sign in to the website.`, true)}
                      >
                        {p.role === "pending" ? "Decline" : "Suspend"}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Panel>
  );
}
